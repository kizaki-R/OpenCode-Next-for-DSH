/**
 * OpenCode Go 訂閱資格驗證與目錄預覽服務（Stage 1）。
 *
 * 職責：
 *   - 協調獨立 Go 憑證解析與官方唯讀端點（`/usage` → `/models`）。
 *   - 強制隔離快取與世代檢查，防止換 key 或停用時舊的非同步請求回寫狀態。
 *   - 在 Stage 1 僅對設定頁提供模型預覽（`previewModels`），正式選單（`getPickerModels()`）
 *     在 Stage 2 推論完成前保持為空陣列。
 */

import { GO_CREDENTIAL_ENV_VAR, GO_PROVIDER, GO_PROVIDER_NAME } from '../constants.js';
import { defaultGoPickerPath, PickerStore } from '../picker.js';
import {
  clearGoCredential,
  describeGoCredential,
  getDshCredentialCapabilities,
  redactSecret,
  resolveGoCredential,
  saveGoCredential
} from './credentials.js';
import { classifyGoPickerModel, cloneGoModels, GoCacheStore, isEligibleGoPickerModel, supportsGoImageInput } from './catalog.js';
import { fetchGoModels, fetchGoUsage, GoClientError } from './client.js';

function mapErrorToState(err) {
  const category = err?.category || 'transient';
  switch (category) {
    case 'invalid-key':
      return 'invalid-key';
    case 'no-entitlement':
      return 'no-entitlement';
    case 'permission-policy':
      return 'permission-policy';
    case 'redirect-blocked':
    case 'invalid-destination':
      return 'redirect-blocked';
    case 'invalid-response':
      return 'invalid-response';
    case 'transient':
      return err?.subCategory === 'rate-limited' ? 'rate-limited' : 'transient-error';
    case 'aborted':
      return 'unconfigured';
    default:
      return 'transient-error';
  }
}

export function createGoService({
  ctx = null,
  config = {},
  version = '0.0.0',
  fetchFn = globalThis.fetch,
  env = process.env,
  cacheStore = undefined,
  pickerStore = undefined
} = {}) {
  let enabled = config?.enabled === true;
  const providerId = (typeof config?.providerId === 'string' && config.providerId.trim()) || GO_PROVIDER;
  const providerName = (typeof config?.providerName === 'string' && config.providerName.trim()) || GO_PROVIDER_NAME;
  const credentialRef = (typeof config?.credentialRef === 'string' && config.credentialRef.trim()) || GO_CREDENTIAL_ENV_VAR;
  const userAgent = `opencode-next/${version || '0.0.0'} (opencode-go)`;

  const store = cacheStore !== undefined
    ? cacheStore
    : new GoCacheStore(config?.cachePath === null ? null : (config?.cachePath || undefined));
  const picker = pickerStore !== undefined
    ? pickerStore
    : new PickerStore({ path: config?.pickerPath === null ? null : (config?.pickerPath || defaultGoPickerPath()) });

  let generation = 0;
  let disposed = false;
  let activeController = null;
  let inFlight = null;
  let activeFingerprint = null;

  let connectionState = enabled ? 'unconfigured' : 'disabled';
  let usage = null;
  let previewModels = [];
  let checkedAt = null;
  let lastError = null;
  const initialCapabilities = getDshCredentialCapabilities(ctx);
  let lastBilling = null;
  let lastCredentialMeta = describeGoCredential({
    present: false,
    source: null,
    ref: credentialRef,
    fingerprint: null,
    dshCredentialsAvailable: Boolean(initialCapabilities.service),
    canSave: initialCapabilities.canSet,
    canClear: initialCapabilities.canUnset
  });

  const resetCachedState = ({ nextState } = {}) => {
    generation++;
    if (activeController) {
      try { activeController.abort(); } catch {}
      activeController = null;
    }
    inFlight = null;
    activeFingerprint = null;
    usage = null;
    previewModels = [];
    checkedAt = null;
    lastError = null;
    lastBilling = null;
    connectionState = nextState ?? (enabled ? 'unconfigured' : 'disabled');
    store?.clear?.();
  };

  /**
   * 僅從本機解析憑證與恢復相符指紋的快取，不發起網路請求。
   */
  const init = async () => {
    if (disposed || !enabled) {
      if (!disposed && !enabled) connectionState = 'disabled';
      return getStatus();
    }
    const myGen = ++generation;
    const cred = await resolveGoCredential({ ctx, credentialRef, env });

    // 非同步憑證解析期間若已 clear()、setEnabled(false)、dispose() 或有更新的操作，
    // 過期操作不可改動狀態、憑證中繼資料或快取。
    if (disposed || !enabled || myGen !== generation) {
      return getStatus();
    }

    lastCredentialMeta = describeGoCredential(cred);

    if (!cred.present) {
      activeFingerprint = null;
      usage = null;
      previewModels = [];
      checkedAt = null;
      lastError = cred.error
        ? {
            category: 'invalid-key',
            subCategory: cred.error,
            status: null,
            retryable: false,
            retryAfterMs: null,
            message: cred.message
          }
        : null;
      connectionState = cred.error ? 'invalid-key' : 'unconfigured';
      store?.clear?.();
      return getStatus();
    }

    activeFingerprint = cred.fingerprint;
    const cached = store?.read?.(cred.fingerprint) ?? null;
    if (cached) {
      usage = cached.usage ? structuredClone(cached.usage) : null;
      previewModels = cloneGoModels(cached.previewModels);
      checkedAt = cached.checkedAt;
      connectionState = 'connected';
      lastError = null;
    } else {
      store?.clear?.();
      connectionState = 'unconfigured';
    }
    return getStatus();
  };

  /**
   * 解析憑證並依序查詢 `/usage` 與 `/models`。
   */
  const refresh = async (_opts = {}) => {
    if (disposed || !enabled) {
      resetCachedState({ nextState: 'disabled' });
      return getStatus();
    }

    if (activeController) {
      try { activeController.abort(); } catch {}
      activeController = null;
    }

    const myGen = ++generation;
    const cred = await resolveGoCredential({ ctx, credentialRef, env });

    // 非同步憑證解析期間若已發生清除、停用、處置或較新的 refresh()，
    // 過期操作不可更新狀態、不可送出 HTTP，也不可覆寫快取。
    if (disposed || !enabled || myGen !== generation) {
      return getStatus();
    }

    lastCredentialMeta = describeGoCredential(cred);

    if (!cred.present) {
      const nextState = cred.error ? 'invalid-key' : 'unconfigured';
      // 保留 myGen，避免把 resetCachedState 內再加世代的行為影響其他追蹤
      activeFingerprint = null;
      usage = null;
      previewModels = [];
      checkedAt = null;
      lastError = cred.error
        ? {
            category: 'invalid-key',
            subCategory: cred.error,
            status: null,
            retryable: false,
            retryAfterMs: null,
            message: cred.message
          }
        : null;
      connectionState = nextState;
      store?.clear?.();
      return getStatus();
    }

    // 換 key 時立即清除舊快取（不遞增 generation，因為 myGen 已是最新世代）。
    if (activeFingerprint && activeFingerprint !== cred.fingerprint) {
      usage = null;
      previewModels = [];
      checkedAt = null;
      lastError = null;
      store?.clear?.();
    }
    activeFingerprint = cred.fingerprint;

    const myFingerprint = cred.fingerprint;
    const controller = new AbortController();
    activeController = controller;
    connectionState = 'checking';
    lastError = null;

    const isStillCurrent = () => (
      !disposed
      && enabled
      && myGen === generation
      && activeFingerprint === myFingerprint
    );

    const run = (async () => {
      try {
        const nextUsage = await fetchGoUsage({
          key: cred.key,
          fetchFn,
          signal: controller.signal,
          userAgent
        });
        if (!isStillCurrent()) return getStatus();

        const nextModels = await fetchGoModels({
          key: cred.key,
          fetchFn,
          signal: controller.signal,
          userAgent
        });
        if (!isStillCurrent()) return getStatus();

        const now = Date.now();
        usage = nextUsage;
        previewModels = cloneGoModels(nextModels);
        checkedAt = now;
        connectionState = 'connected';
        lastError = null;
        store?.write?.({
          credentialFingerprint: myFingerprint,
          checkedAt: now,
          usage: nextUsage,
          previewModels
        });
        return getStatus();
      } catch (err) {
        // 若在非同步期間已被換 key、停用或清除，嚴禁舊請求回寫任何狀態或快取。
        if (!isStillCurrent()) return getStatus();

        const normalizedErr = err instanceof GoClientError
          ? err
          : new GoClientError(redactSecret(err?.message || 'OpenCode Go verification failed.', cred.key), {
              category: 'transient',
              retryable: true
            });

        const nextState = mapErrorToState(normalizedErr);
        // 資格失效、無效 key 或非合約回應時清除舊模型預覽與用量，避免殘留已連線狀態。
        if (
          nextState === 'invalid-key'
          || nextState === 'no-entitlement'
          || nextState === 'permission-policy'
          || nextState === 'invalid-response'
        ) {
          usage = null;
          previewModels = [];
          checkedAt = null;
          store?.clear?.();
        } else {
          // 暫時性失敗絕不把用量偽裝成 0%。
          usage = null;
        }
        connectionState = nextState;
        lastError = {
          category: normalizedErr.category,
          subCategory: normalizedErr.subCategory ?? null,
          status: normalizedErr.status ?? null,
          retryable: Boolean(normalizedErr.retryable),
          retryAfterMs: Number.isFinite(normalizedErr.retryAfterMs) ? normalizedErr.retryAfterMs : null,
          message: redactSecret(normalizedErr.message, cred.key)
        };
        return getStatus();
      } finally {
        if (activeController === controller) activeController = null;
        if (inFlight?.generation === myGen) inFlight = null;
      }
    })();

    inFlight = { promise: run, generation: myGen, fingerprint: myFingerprint };
    return run;
  };

  const clear = () => {
    const caps = getDshCredentialCapabilities(ctx);
    resetCachedState({ nextState: enabled ? 'unconfigured' : 'disabled' });
    lastCredentialMeta = describeGoCredential({
      present: false,
      source: null,
      ref: credentialRef,
      fingerprint: null,
      dshCredentialsAvailable: Boolean(caps.service) || lastCredentialMeta.dshCredentialsAvailable,
      canSave: caps.canSet,
      canClear: caps.canUnset
    });
    return getStatus();
  };

  const setEnabled = (nextEnabled) => {
    enabled = nextEnabled === true;
    if (!enabled) {
      const caps = getDshCredentialCapabilities(ctx);
      resetCachedState({ nextState: 'disabled' });
      lastCredentialMeta = describeGoCredential({
        present: false,
        source: null,
        ref: credentialRef,
        fingerprint: null,
        dshCredentialsAvailable: Boolean(caps.service) || lastCredentialMeta.dshCredentialsAvailable,
        canSave: caps.canSet,
        canClear: caps.canUnset
      });
    } else if (connectionState === 'disabled') {
      connectionState = 'unconfigured';
    }
    return getStatus();
  };

  /**
   * 僅從本機重新解析 Go 憑證（含 DSH 憑證服務與環境變數），不發起任何網路請求。
   */
  const syncCredential = async () => {
    if (disposed) {
      return getStatus();
    }
    const myGen = ++generation;
    const cred = await resolveGoCredential({ ctx, credentialRef, env });
    if (disposed || myGen !== generation) {
      return getStatus();
    }

    lastCredentialMeta = describeGoCredential(cred);
    if (!enabled) {
      activeFingerprint = null;
      usage = null;
      previewModels = [];
      checkedAt = null;
      lastError = null;
      lastBilling = null;
      connectionState = 'disabled';
      return getStatus();
    }

    if (!cred.present) {
      activeFingerprint = null;
      usage = null;
      previewModels = [];
      checkedAt = null;
      lastError = cred.error
        ? {
            category: 'invalid-key',
            subCategory: cred.error,
            status: null,
            retryable: false,
            retryAfterMs: null,
            message: cred.message
          }
        : null;
      connectionState = cred.error ? 'invalid-key' : 'unconfigured';
      store?.clear?.();
      return getStatus();
    }

    activeFingerprint = cred.fingerprint;
    const cached = store?.read?.(cred.fingerprint) ?? null;
    if (cached) {
      usage = cached.usage ? structuredClone(cached.usage) : null;
      previewModels = cloneGoModels(cached.previewModels);
      checkedAt = cached.checkedAt;
      connectionState = 'connected';
      lastError = null;
    } else {
      store?.clear?.();
      connectionState = 'unconfigured';
    }
    return getStatus();
  };

  /**
   * 透過 DSH 憑證服務儲存 OpenCode Go Personal API Key，寫入後僅重新解析本機憑證，不自動發起推論。
   */
  const saveCredential = async (rawKey) => {
    if (disposed) {
      return {
        ok: false,
        error: 'disposed',
        message: 'OpenCode Go service is disposed.',
        status: getStatus()
      };
    }
    const res = await saveGoCredential({ ctx, credentialRef, key: rawKey });
    if (!res.ok) {
      return {
        ok: false,
        error: res.error,
        message: res.message,
        status: getStatus()
      };
    }
    resetCachedState({ nextState: enabled ? 'unconfigured' : 'disabled' });
    await syncCredential();
    return {
      ok: true,
      status: getStatus()
    };
  };

  /**
   * 透過 DSH 憑證服務清除已儲存的 OpenCode Go API Key，清除後重新解析本機憑證（可退回環境變數）。
   */
  const clearCredential = async () => {
    if (disposed) {
      return {
        ok: false,
        error: 'disposed',
        message: 'OpenCode Go service is disposed.',
        status: getStatus()
      };
    }
    const res = await clearGoCredential({ ctx, credentialRef });
    if (!res.ok) {
      return {
        ok: false,
        error: res.error,
        message: res.message,
        status: getStatus()
      };
    }
    resetCachedState({ nextState: enabled ? 'unconfigured' : 'disabled' });
    await syncCredential();
    return {
      ok: true,
      status: getStatus()
    };
  };

  const dispose = () => {
    disposed = true;
    generation++;
    if (activeController) {
      try { activeController.abort(); } catch {}
      activeController = null;
    }
    inFlight = null;
  };

  const getPreviewModels = () => cloneGoModels(previewModels);

  const isPublishedGoPickerModel = (m) => {
    if (!isEligibleGoPickerModel(m)) return false;
    const p = picker.get();
    if (p.mode !== 'manual') return true;
    return p.shown.includes(m.id);
  };

  /**
   * Stage 2：僅在已啟用且資格驗證連線通過時，發布已驗證且勾選的 Go 文字模型至正式選單。
   */
  const getPickerModels = () => {
    if (disposed || !enabled || connectionState !== 'connected') {
      return [];
    }
    return cloneGoModels(previewModels.filter(isPublishedGoPickerModel));
  };

  const pickerState = () => picker.get();

  const setPickerShown = (modelId, shown) => {
    const id = typeof modelId === 'string' ? modelId.trim() : '';
    const target = previewModels.find((m) => m.id === id);
    if (!target || !isEligibleGoPickerModel(target)) return null;
    const cur = picker.get();
    const set = new Set(
      cur.mode === 'manual'
        ? cur.shown
        : previewModels.filter(isEligibleGoPickerModel).map((m) => m.id)
    );
    if (shown) set.add(id);
    else set.delete(id);
    return picker.set({ mode: 'manual', shown: [...set] });
  };

  const resetPicker = () => picker.set({ mode: 'auto', shown: [] });

  /**
   * 解析本次推論所需之已驗證憑證與合格模型（僅供 Go adapter 內部使用）。
   */
  const getInferenceContext = async (modelId) => {
    if (disposed || !enabled) {
      throw new GoClientError('OpenCode Go provider is disabled.', {
        category: 'invalid-request',
        subCategory: 'go-disabled',
        retryable: false
      });
    }
    if (connectionState !== 'connected') {
      throw new GoClientError('OpenCode Go subscription is not verified/connected.', {
        category: connectionState === 'no-entitlement' ? 'no-entitlement' : 'invalid-key',
        subCategory: connectionState,
        retryable: false
      });
    }
    const eligible = previewModels.find((m) => m.id === modelId && isEligibleGoPickerModel(m));
    if (!eligible) {
      throw new GoClientError(`Model "${modelId}" is not an eligible OpenCode Go text model.`, {
        category: 'invalid-request',
        subCategory: 'model-not-eligible',
        retryable: false
      });
    }

    const cred = await resolveGoCredential({ ctx, credentialRef, env });
    if (disposed || !enabled || connectionState !== 'connected') {
      throw new GoClientError('OpenCode Go connection was invalidated during credential resolution.', {
        category: 'invalid-key',
        subCategory: 'credential-invalidated',
        retryable: false
      });
    }
    if (!cred.present) {
      throw new GoClientError(cred.message || 'Missing OpenCode Go API key.', {
        category: 'invalid-key',
        subCategory: cred.error || 'missing-key',
        retryable: false
      });
    }
    if (activeFingerprint && cred.fingerprint !== activeFingerprint) {
      throw new GoClientError('OpenCode Go API key changed; re-verify subscription before inference.', {
        category: 'invalid-key',
        subCategory: 'credential-changed',
        retryable: false
      });
    }

    return {
      key: cred.key,
      model: cloneGoModels([eligible])[0],
      userAgent,
      fetchFn
    };
  };

  const noteBilling = (usageChunk) => {
    if (!usageChunk || typeof usageChunk !== 'object') return;
    lastBilling = {
      cost: typeof usageChunk.cost === 'number' && Number.isFinite(usageChunk.cost) ? usageChunk.cost : null,
      billingSource: typeof usageChunk.opencode?.billing_source === 'string'
        ? usageChunk.opencode.billing_source
        : null,
      allowance: typeof usageChunk.opencode?.allowance === 'number' && Number.isFinite(usageChunk.opencode.allowance)
        ? usageChunk.opencode.allowance
        : null,
      recordedAt: Date.now()
    };
  };

  const getStatus = () => {
    const pickerModels = getPickerModels();
    const published = !disposed && enabled && connectionState === 'connected';
    const currentPicker = picker.get();
    const annotatedPreview = cloneGoModels(previewModels).map((m) => {
      const classification = classifyGoPickerModel(m);
      const isSelected = currentPicker.mode !== 'manual' || currentPicker.shown.includes(m.id);
      return {
        ...m,
        pickerEligible: classification.eligible,
        pickerPublished: published && classification.eligible && isSelected,
        pickerImageSupported: Boolean(published && supportsGoImageInput(m)),
        pickerReasons: classification.reasons
      };
    });
    const liveCaps = getDshCredentialCapabilities(ctx);
    return {
      enabled,
      providerId,
      providerName,
      connectionState,
      inferenceSupported: true,
      pickerPublishedCount: pickerModels.length,
      picker: currentPicker,
      credential: {
        ...lastCredentialMeta,
        dshCredentialsAvailable: Boolean(liveCaps.service) || lastCredentialMeta.dshCredentialsAvailable,
        canSave: liveCaps.canSet || lastCredentialMeta.canSave,
        canClear: liveCaps.canUnset || lastCredentialMeta.canClear
      },
      usage: usage ? structuredClone(usage) : null,
      lastBilling: lastBilling ? { ...lastBilling } : null,
      previewModels: annotatedPreview,
      checkedAt,
      error: lastError ? { ...lastError } : null
    };
  };

  return {
    init,
    refresh,
    clear,
    syncCredential,
    saveCredential,
    clearCredential,
    setEnabled,
    dispose,
    isEnabled: () => enabled,
    providerId: () => providerId,
    providerName: () => providerName,
    getPreviewModels,
    getPickerModels,
    pickerState,
    setPickerShown,
    resetPicker,
    getInferenceContext,
    noteBilling,
    getStatus
  };
}
