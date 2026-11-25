/**
 * 狀態頁（browser half）。
 *
 * 這支檔案是在瀏覽器裡執行的，跟 lib/ 其他模組的環境完全不同，所以有幾件事
 * 必須照著固定規則來，否則整頁會靜默地不出現：
 *
 *  1. 檔案外層必須是 `window.__ModuleLoader__.load({ id, factory })` 這個封套。
 *     它不是 ESM，所以**不能**用 import；只能用 `require("react")`。
 *  2. 這個檔案是「宿主外掛」與「瀏覽器外掛」共用一個 package 的後者，必須在
 *     package.json 的 `dsh.client` 與 `exports["./client"]` 被指到，宿主才會
 *     把它送進瀏覽器。
 *  3. 掛進 `settings.section` 這個 slot，order 用 14（12 與 13 已被 antigravity
 *     與 agy-next 佔用，15 之後也有人用了）。
 *  4. `locale` 必須列入 inject：DSH 只內建 zh（簡體）與 en，繁中字典要靠
 *     addLanguage 自己宣告一個 id 才存在。碰到沒注入的 Cordis 服務會直接讓
 *     外掛啟動失敗，所以這裡不能省。
 *
 * 樣式刻意全部自己帶（不依賴宿主 UI 套件的元件），但顏色一律走宿主的
 * `--dsw-alias-*` 主題變數：這樣淺色／深色主題切換會自動跟著走，而不是把顏色
 * 寫死。自帶樣式的好處是這個檔案只需要 react 一個相依，不會因為宿主套件
 * 版本不同而整頁載入失敗。
 */

window.__ModuleLoader__.load({
  id: 'opencode-next',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/opencode-next/api';
    const NS = 'opencode-next';
    const STYLE_ID = 'opencode-next-settings-style';

    /* --------------------------------------------------------------- 文案 */

    const COPY = {
      en: {
        nav: 'OpenCode-Next',
        title: 'OpenCode-Next',
        subtitle: 'Sign-in state, the models this provider serves, and how each one responded to the last probe.',
        refreshing: 'Refreshing…',
        login: 'Sign in',
        loggingIn: 'Waiting for approval…',
        cancelling: 'Cancelling…',
        cancelLogin: 'Cancel sign-in',
        reauth: 'Sign in again',
        importLocal: 'Import from OpenCode Desktop',
        importingLocal: 'Importing…',
        importLocalDone: 'Imported the OpenCode Desktop sign-in as an account.',
        importLocalAlready: 'This OpenCode Desktop sign-in is already imported.',
        logout: 'Sign out',
        reprobe: 'One-click probe',
        reprobeAvailable: 'Probe available ({n})',
        reprobeFiltered: 'Probe list ({n})',
        probing: 'Probing…',
        verify: 'Re-verify credential',

        sectionAccount: 'Authorization',
        sectionAccounts: 'Accounts', accountAdd: 'Add account', accountLabel: 'Account label', accountLabelPlaceholder: 'Optional label', accountStart: 'Start sign-in', accountCancel: 'Cancel', accountSwitch: 'Switch', accountActive: 'Active', accountExpired: 'Expired', accountExpiry: '{time} left', accountRemove: 'Remove', accountRemoveConfirm: 'Remove this account permanently?', accountCannotRemoveLast: 'At least one account must remain', accountSwitched: 'Switched to {label}', accountNoLabel: 'Unnamed', accountAddHint: 'Authorize a new OpenCode account with device sign-in.',
        sectionModels: 'Models',
        sectionDetails: 'Diagnostics',
        stateReady: 'Ready',
        stateExpiring: 'Expiring soon',
        stateUnprobed: 'Not probed yet',
        stateSignedOut: 'Not signed in',
        stateExpired: 'Expired',
        stateNoModels: 'No model responding',
        stateDegraded: 'Some models unavailable',
        stateUnknown: 'Unknown',

        hReady: 'The credential is valid and models are responding.',
        hSignedOut: 'Not signed in to OpenCode yet. Complete the device authorization below.',
        hExpired: 'The credential has expired. Sign in again, or re-verify it.',
        hNoModels: 'The credential is fine, but no model responded. The free lane may be blocking requests, or the egress IP may be restricted.',
        hDegraded: 'The credential is valid, but not every model is usable. See the breakdown below.',
        hUnprobed: 'The credential is fine. Model availability has not been probed yet.',
        hExpiring: 'The credential expires soon; it will be refreshed automatically.',

        credAbsent: 'No credential',
        credSource: 'Source',
        credExpiry: 'Expires',
        credRefreshable: 'Auto-refresh',
        credYes: 'available',
        credNo: 'unavailable',
        srcAccounts: 'Signed-in account',
        srcLocalDb: 'OpenCode Desktop database',
        srcAuthJson: 'OpenCode auth.json',
        srcTokenFile: 'Saved by this plugin',
        srcUnknown: 'unknown source',

        expiresIn: '{time} left',
        expiresAt: 'at {when}',
        expiresPast: 'already expired',
        expiresNoExpiry: 'no expiry reported',

        signedOutHint:
          'No OpenCode credential yet. Sign in below, or sign in with OpenCode Desktop and this plugin will inherit the token automatically.',
        loginHint: 'Open this URL and confirm the code shown there matches:',
        userCode: 'Code',
        openAgain: 'Open the sign-in page again',
        waiting: 'A browser window should have opened. Approve access there; this page updates by itself.',
        loginCancelled: 'That sign-in was cancelled because you signed out. Start it again when you are ready.',
        loginFailed: 'Sign-in did not finish: {message}',
        loginFailedTimeout: 'Sign-in timed out. Start it again when you are ready.',
        loginFailedDenied: 'Sign-in was denied. Start it again if you still want to connect.',
        loginFailedExpired: 'That sign-in code expired. Start again to get a new one.',
        loginFailedNetwork: 'Could not reach OpenCode. Check the network and try again.',
        copy: 'Copy',
        copied: 'Copied',

        modelsAvailable: '{ok} of {total} responding',
        filterAll: 'All',
        filterAvailable: 'Available',
        filterCount: '{shown} of {total} shown',
        rowDetails: 'Show probe details and context size',
        modelFilters: 'Filter models by availability or probe result',
        probedAgo: 'Last probed: {when} (manual)',
        neverProbed: 'Not probed yet (manual mode)',
        truncatedRateLimit: 'This run stopped after {tested} of {total}: a model hit a rate limit. Untested models keep their previous result.',
        truncatedUnreachable: 'This run stopped after {tested} of {total}: the free lane became unreachable. Untested models keep their previous result.',
        quotaReset: 'Free quota resets {when} (in {in}).',
        quotaResetReady: 'The free quota window has reset. You can probe or chat again.',
        quotaResetUnknown: 'Free quota is exhausted; upstream did not say when it resets.',
        colModel: 'Model',
        colStatus: 'Status',
        colContext: 'Context',
        colLatency: 'Latency',
        statusOk: 'OK',
        statusFail: 'Unavailable',
        statusLimited: 'Throttled',
        statusUnprobed: 'Not probed',
        pickerAvailable: 'In picker',
        pickerHidden: 'Hidden from picker',
        colPicker: 'Show',
        pickerShow: 'Show in picker',
        pickerManual: 'Curated — {n} of {total} shown. New models no longer appear automatically.',
        pickerAuto: 'Auto — every verified model is shown.',
        pickerReset: 'Show all available',
        pickerResetBusy: 'Resetting…',
        pickerAutoShort: 'Auto',
        pickerManualShort: 'Curated',
        modelProbedAt: 'Probed {when}',
        modelFailureStreak: '{count}/2 consecutive failures',
        modelsCaption: 'Availability',
        tabAccount: 'Account',
        tabModels: 'Free Models',
        tabAdvanced: 'Advanced',
        tabGo: 'OpenCode Go',
        unitDay: 'd',
        unitHour: 'h',
        unitMinute: 'm',
        unitLessThanMinute: '<1m',
        showAll: 'Show all {n} models',
        showRest: 'Show the remaining {n} of {total}',
        showLess: 'Show fewer',
        onlyProblems: 'Problems only',
        searchPlaceholder: 'Filter models',
        noMatch: 'No model matches.',
        contextSummary: 'Context window: {effective} tokens · {source}',
        contextSetting: 'Context window',
        contextMode: 'Capacity source',
        contextDefault: 'Follow OpenCode default',
        contextCustom: 'Custom value',
        contextPublished: 'Published/default value: {value} tokens',
        contextSourceOpenCode: 'OpenCode catalog',
        contextSourceFallback: 'Plugin fallback',
        contextSourceCustom: 'Manual override',
        contextValue: 'Context window (tokens)',
        contextHint: 'This value changes DSH’s model budget only. It does not raise OpenCode’s actual limit or change DSH’s compaction policy.',
        contextSave: 'Save',
        contextSaving: 'Saving…',
        contextReset: 'Restore default',
        contextSaved: 'Context setting saved.',
        contextInvalid: 'Enter a whole number from 1,024 to 100,000,000.',
        contextClickToEdit: 'Click to edit context window',
        contextModalTitle: 'Context Window',
        contextModalSub: 'Model: {id}',
        contextDefaultValue: 'Upstream default: {value} tokens',
        contextMaxOutput: 'Max output per reply: {value} tokens',
        contextCustomLabel: 'Custom context window (tokens)',
        contextResetToDefault: 'Restore default',
        contextCancel: 'Cancel',
        contextSaveBtn: 'Save',
        contextCustomBadge: 'Custom',

        sectionAdvanced: 'Advanced',
        sectionBun: 'Bun runtime',
        bunInstalled: 'Detected',
        bunMissing: 'Not installed',
        bunVersion: 'Version',
        bunPath: 'Executable',
        bunEnabled: 'Inference transport',
        bunUsed: 'Bun',
        bunNode: 'Node.js',
        bunLast: 'Last request',
        bunLastNone: 'No inference request in this process yet',
        bunHint: 'OpenCode free models reject Node.js requests. This plugin uses a separately installed Bun; the OpenCode app does not include a bun executable.',
        bunMissingHint: 'Bun was not found. Install it from bun.sh, then press Rescan — no DSH restart is needed.',
        bunDownload: 'Get Bun',
        bunRescan: 'Rescan',
        bunRescanning: 'Scanning…',
        sectionAnonymous: 'Anonymous channel',
        anonOn: 'On',
        anonOff: 'Off',
        anonEnable: 'Send inference without my account credential',
        anonWarning: 'Unofficial usage: this uses the public anonymous lane, which OpenCode does not promise to keep working. It may stop working or be throttled at any time, and it is still subject to your network exit IP. Use it only when you accept that risk.',
        sectionGo: 'OpenCode Go (Subscription)',
        goStateDisabled: 'Disabled',
        goStateUnconfigured: 'No API key',
        goStateChecking: 'Verifying…',
        goStateConnected: 'Connected',
        goStateInvalidKey: 'Invalid key',
        goStateNoEntitlement: 'No Go plan',
        goStatePermissionPolicy: 'Permission / policy error',
        goStateRateLimited: 'Rate limited',
        goStateTransient: 'Temporary failure',
        goStateRedirectBlocked: 'Redirect blocked',
        goStateInvalidResponse: 'Invalid response',
        goProviderIdLabel: 'Provider ID',
        goCredStatusLabel: 'API key',
        goCredSourceDsh: 'DSH credential service ({ref})',
        goCredSourceEnv: 'Environment variable ({ref})',
        goCredSourceMissing: 'Not found ({ref})',
        goCheckedAt: 'Last verified',
        goUsageSummary: 'Usage windows',
        goWindowRolling: '5h Limit',
        goWindowWeekly: '7D Limit',
        goWindowMonthly: '1M Limit',
        goWindowResetsAt: 'resets {when}',
        goWindowUnavailable: '–',
        goExtraUsageWarn: '⚠ If Extra Usage is enabled in Console, overage may bill your workspace balance.',
        goPreviewHint: 'Verified Go chat/tool models are published to the DSH picker (image input is enabled only for Go endpoint-verified image models; unverified catalog vision, video, reasoning, and non-chat capabilities are not advertised).',
        goDisabledHint: 'OpenCode Go is disabled in plugin config (goSubscription.enabled: false). Re-enable it and provide an OpenCode Console Personal API Key via DSH credentials or OPENCODE_GO_API_KEY.',
        goRefresh: 'Re-verify',
        goRefreshing: 'Verifying…',
        goClear: 'Clear cache',
        goPreviewTitle: 'Workspace model preview ({count})',
        goPreviewEmpty: 'No preview models loaded yet.',
        goModelTypeUnknown: 'type: unknown',
        goContextCap: 'ctx {value}',
        goOutputCap: 'out {value}',
        goCapReasoning: 'reasoning',
        goCapTools: 'tools',
        goCapAttachment: 'attachments',
        goModalityInput: 'in: {list}',
        goKeyFieldLabel: 'OpenCode Console Personal API Key ({ref})',
        goKeyStoredStatus: 'Saved',
        goKeyUnsetStatus: 'Not set',
        goKeyStoredPlaceholder: 'Saved (enter a new key to overwrite)',
        goKeyMissingPlaceholder: 'Enter OpenCode Console Personal API Key',
        goKeySave: 'Save',
        goKeySaving: 'Saving…',
        goKeyChange: 'Replace',
        goKeyCancel: 'Cancel',
        goKeyDrawer: 'API Key',
        goApiOnlyNote: 'OpenCode Go currently supports Console Personal API Key auth only (does not share free OAuth login).',
        goKeyClear: 'Clear',
        goKeyClearing: 'Clearing…',
        goKeySavedMsg: 'OpenCode Go API key saved to DSH credential storage.',
        goKeyClearedMsg: 'Cleared OpenCode Go API key from DSH credential storage.',
        goKeyWriteUnavailable: 'DSH credential write (ctx.credentials.set) is unavailable in this process; the key cannot be saved and will not be written to plugin config or JSON files.',
        goFilterAll: 'All',
        goFilterPicker: 'In picker',
        goFilterPreview: 'Preview only',
        goColType: 'Type',
        goColOutput: 'Output',
        goColCaps: 'Catalog caps',
        goStatusInPicker: 'In picker',
        goStatusPreviewOnly: 'Preview only',
        goReasonInactiveStatus: 'status: {status}',
        goReasonMissingType: 'missing type',
        goReasonUnsupportedType: 'non-chat type ({type})',
        goReasonMissingLimits: 'missing limits',
        goReasonNonTextModality: 'non-text modality',
        goReasonNotConnected: 'subscription not connected',
        goReasonInvalidModel: 'invalid metadata',
        goReasonIneligible: 'not eligible for picker',
        goReasonNotVerified: 'not verified for picker',
        goPickerEligibleNote: 'Verified Go chat model; auto-published to the DSH picker (text + tool calling; no live probing or latency ping).',
        goPreviewOnlyNote: 'Remains preview-only and excluded from the DSH picker: {reasons}.',
        goSupportScopeNote: 'Catalog fields show upstream declarations only. Plugin Go channel supports text chat & tool calling, and automatically enables image input for eligible models whose catalog declares image/image/* input; video, audio, and other attachments remain unsupported.',
        goModelSupportImage: 'Plugin Go support: text chat, tool calling & image input (enabled from upstream catalog image modality; actual runtime support depends on the Go endpoint; video, audio & other attachments are unsupported).',
        goModelSupportTextOnly: 'Plugin Go support: text chat & tool calling only (upstream catalog does not declare image input; attached images will be rejected before sending).',
        goCatalogMetaLabel: 'Catalog metadata: {meta}',
        goExpandModelId: 'ID: {id}',
        goExpandModelName: 'Name: {name}',
        goExpandProvider: 'Owner: {owner}',
        goExpandInputLimit: 'Input limit: {value}',
        goExpandModalityIn: 'In: {list}',
        goExpandModalityOut: 'Out: {list}',
        goNoMatch: 'No Go models match this filter.',
        sectionAutoSwitch: 'Automatic account switching',
        sectionFallback: 'Model fallback',
        autoSwitchEnable: 'Automatically switch account after confirmed credential rejection',
        autoSwitchHint: 'Off by default. Only a 401 after refreshing the same saved account may switch; rate limits and network/model blocks never do.',
        autoSwitchSaved: 'Automatic account switching setting saved.',
        fallbackEnable: 'Switch to the next priority when a model fails',
        fallbackHint: 'Only switches when the failure belongs to that model alone (retired, deprecated, geo-restricted, timed out). A blocked network or invalid sign-in is reported instead of being masked.',
        fallbackSlot: 'Priority {n}',
        fallbackNone: 'Not set',
        fallbackSave: 'Save',
        fallbackSaving: 'Saving…',
        fallbackSaved: 'Fallback settings saved.',
        fallbackOffNote: 'Fallback is off. A failing model returns its error directly.',
        fallbackNeedProbe: 'Probe the models first to pick priorities from the available ones.',

        rFreeTier: 'Free lane rejected this request',
        rNetworkBlocked: 'Network blocked — turn off VPN/proxy',
        rRegion: 'Region-restricted model',
        rUnauthorized: 'Authorization rejected',
        rForbidden: 'Upstream refused (403)',
        rQuota: 'Quota exhausted',
        rRateLimit: 'Rate limited',
        rUpstream: 'Upstream server error',
        rNotFound: 'Model not found',
        rDeprecated: 'Model retired',
        rUnavailable: 'Model unavailable',
        shortUnavailable: 'Unavailable',
        shortDeprecated: 'Retired',
        shortQuota: 'Quota',
        shortRateLimit: 'Rate limited',
        shortRegion: 'Region',
        shortFreeTier: 'Lane blocked',
        shortNetwork: 'Network',
        shortTransport: 'Offline',
        shortNotFound: 'Not found',
        shortUpstream: 'Upstream',
        shortBadRequest: 'Rejected',
        shortContextOverflow: 'Too long',
        shortUnauthorized: 'Unauthorized',
        shortForbidden: 'Forbidden',
        shortUnknown: 'Unknown',
        rContextOverflow: 'Context length exceeded',
        rBadRequest: 'Rejected (400, no detail)',
        rTransport: 'Connection failed',
        availRatio: '{a}/{b} models usable',
        rUnknown: 'Unknown status',

        detailProvider: 'Provider id',
        detailVersion: 'Plugin version',
        detailProbeInterval: 'Probe interval',
        detailCatalogPoll: 'Catalog poll',
        detailPixelBudget: 'Image pixel budget',
        detailMaxBytes: 'Image byte cap',
        detailAutoDetect: 'Auto-detect models',
        detailGenerated: 'Snapshot taken',

        on: 'on',
        off: 'off',
        errorGeneric: 'Something went wrong: {message}',
        loadFailed: 'Could not read the plugin status.',
        intervalHours: '{h} h',
        intervalMinutes: '{m} min',

        /* Language switcher */
        languageLabel: 'Language',
        languageAuto: 'Follow system',
        languageEn: 'English',
        languageZh: '简体中文',
        languageZhHant: '繁體中文',
        languageOf_en: 'English',
        languageOf_zh: '简体中文',
        'languageOf_zh-Hant': '繁體中文',
      },

      zh: {
        nav: 'OpenCode-Next',
        title: 'OpenCode-Next',
        subtitle: '登录授权状态、这个 provider 提供的模型，以及每个模型最近一次探测的响应。',
        refreshing: '正在刷新…',
        login: '登录',
        loggingIn: '等待授权中…',
        cancelling: '正在取消…',
        cancelLogin: '取消登录',
        reauth: '重新登录',
        importLocal: '从 OpenCode Desktop 导入',
        importingLocal: '导入中…',
        importLocalDone: '已把 OpenCode Desktop 的登录状态导入为账号。',
        importLocalAlready: '这组 OpenCode Desktop 登录已经导入过。',
        logout: '退出登录',
        reprobe: '一键探测',
        reprobeAvailable: '探测可用 ({n})',
        reprobeFiltered: '探测清单 ({n})',
        probing: '探测中…',
        verify: '重新验证凭证',

        sectionAccount: '授权状态',
        sectionAccounts: '账号', accountAdd: '添加账号', accountLabel: '账号标签', accountLabelPlaceholder: '可选标签', accountStart: '开始登录', accountCancel: '取消', accountSwitch: '切换', accountActive: '使用中', accountExpired: '已过期', accountExpiry: '剩余 {time}', accountRemove: '移除', accountRemoveConfirm: '确定移除此账号？此操作无法撤销。', accountCannotRemoveLast: '至少要保留一个账号', accountSwitched: '已切换到 {label}', accountNoLabel: '未命名', accountAddHint: '通过设备授权登录新的 OpenCode 账号。',
        sectionModels: '模型',
        sectionDetails: '诊断信息',

        stateReady: '正常',
        stateExpiring: '即将过期',
        stateUnprobed: '尚未探测',
        stateSignedOut: '尚未登录',
        stateExpired: '已过期',
        stateNoModels: '没有模型响应',
        stateDegraded: '部分模型不可用',
        stateUnknown: '未知',

        hReady: '授权有效，模型可用。',
        hSignedOut: '尚未登录 OpenCode，请先完成设备授权。',
        hExpired: '授权已过期，请重新登录或刷新凭证。',
        hNoModels: '授权正常，但目前没有任何模型响应；可能是免费通道被拦截，或出口 IP 受限。',
        hDegraded: '授权有效，但并非所有模型都能用；请看下方的分类统计。',
        hUnprobed: '授权正常，尚未探测模型可用性。',
        hExpiring: '授权即将到期，系统会自动刷新。',

        credAbsent: '没有凭证',
        credSource: '来源',
        credExpiry: '到期',
        credRefreshable: '自动更新',
        credYes: '可用',
        credNo: '不可用',
        srcAccounts: '已登录账号',
        srcLocalDb: 'OpenCode Desktop 数据库',
        srcAuthJson: 'OpenCode auth.json',
        srcTokenFile: '本插件保存',
        srcUnknown: '未知来源',

        expiresIn: '剩余 {time}',
        expiresAt: '于 {when}',
        expiresPast: '已过期',
        expiresNoExpiry: '未报告到期时间',

        signedOutHint: '尚未取得 OpenCode 凭证。可在下方登录，或用 OpenCode Desktop 登录后由本插件自动沿用其 token。',
        loginHint: '打开下列网址，并确认网页上显示的代码与此相同：',
        userCode: '代码',
        openAgain: '再次打开登录页',
        waiting: '应该已打开浏览器窗口，请在该页面同意授权；本页会自动更新。',
        loginCancelled: '这次登录已取消，因为你已退出登录。准备好时再重新开始即可。',
        loginFailed: '登录没有完成：{message}',
        loginFailedTimeout: '登录超时。准备好时再重新开始即可。',
        loginFailedDenied: '授权被拒绝。若仍要连接，请重新开始登录。',
        loginFailedExpired: '这组登录代码已过期。请重新开始以取得新的代码。',
        loginFailedNetwork: '连不到 OpenCode。请检查网络后再试一次。',
        copy: '复制',
        copied: '已复制',

        modelsAvailable: '{total} 个中有 {ok} 个有响应',
        filterAll: '全部',
        filterAvailable: '可用',
        filterCount: '显示 {shown}／{total}',
        rowDetails: '展开探测细节与上下文大小',
        modelFilters: '依模型可用状态或探测结果筛选',
        probedAgo: '上次探测：{when}（手动）',
        neverProbed: '尚未探测（手动模式）',
        truncatedRateLimit: '本轮只验了 {tested}/{total}：某个模型遇到限流或额度用尽就停手。未验的模型保留上次结果。',
        truncatedUnreachable: '本轮只验了 {tested}/{total}：免费通道中断。未验的模型保留上次结果。',
        quotaReset: '免费额度将于 {when} 重置（还有 {in}）。',
        quotaResetReady: '免费额度窗口已重置，可以重新探测或对话。',
        quotaResetUnknown: '免费额度已用尽；上游没有说明何时重置。',
        colModel: '模型',
        colStatus: '状态',
        colContext: '上下文',
        colLatency: '延迟',
        statusOk: '正常',
        statusFail: '不可用',
        statusLimited: '受限',
        statusUnprobed: '未探测',
        pickerAvailable: '在模型清单中',
        pickerHidden: '已从模型清单隐藏',
        colPicker: '显示',
        pickerShow: '在模型清单中显示',
        pickerManual: '手动挑选 — 显示 {n}/{total} 个，新模型不再自动出现。',
        pickerAuto: '自动 — 所有通过验证的模型都会显示。',
        pickerReset: '显示全部可用模型',
        pickerResetBusy: '还原中…',
        pickerAutoShort: '自动',
        pickerManualShort: '手选',
        modelProbedAt: '探测时间：{when}',
        modelFailureStreak: '连续失败 {count}/2 次',
        modelsCaption: '可用状态',
        tabAccount: '账号',
        tabModels: '免费模型',
        tabAdvanced: '进阶',
        tabGo: 'OpenCode Go',
        unitDay: '天',
        unitHour: '小时',
        unitMinute: '分',
        unitLessThanMinute: '不到 1 分钟',
        showAll: '显示全部 {n} 个模型',
        showRest: '显示其余 {n} 个（共 {total} 个）',
        showLess: '收起',
        onlyProblems: '只看有问题的',
        searchPlaceholder: '筛选模型',
        noMatch: '没有匹配的模型。',
        contextSummary: '上下文大小：{effective} tokens · {source}',
        contextSetting: '上下文大小',
        contextMode: '容量来源',
        contextDefault: '跟随 OpenCode 默认值',
        contextCustom: '自定义数值',
        contextPublished: '目录／默认值：{value} tokens',
        contextSourceOpenCode: 'OpenCode 模型目录',
        contextSourceFallback: '插件备用值',
        contextSourceCustom: '手动覆写',
        contextValue: '上下文大小（tokens）',
        contextHint: '此数值只会改变 DSH 的模型预算，不会提高 OpenCode 的实际上限，也不会改变 DSH 的压缩策略。',
        contextSave: '保存',
        contextSaving: '保存中…',
        contextReset: '恢复默认值',
        contextSaved: '上下文设置已保存。',
        contextInvalid: '请输入 1,024 到 100,000,000 之间的整数。',
        contextClickToEdit: '单击设置上下文上限',
        contextModalTitle: '设置上下文上限',
        contextModalSub: '模型：{id}',
        contextDefaultValue: '上游默认值：{value} tokens',
        contextMaxOutput: '单次回复输出上限：{value} tokens',
        contextCustomLabel: '自定义上限（tokens）',
        contextResetToDefault: '恢复默认值',
        contextCancel: '取消',
        contextSaveBtn: '保存',
        contextCustomBadge: '自定义',

        sectionAdvanced: '进阶设置',
        sectionBun: 'Bun 运行环境',
        bunInstalled: '已检测到',
        bunMissing: '未安装',
        bunVersion: '版本',
        bunPath: '执行文件',
        bunEnabled: '推理传输',
        bunUsed: 'Bun',
        bunNode: 'Node.js',
        bunLast: '最近一次请求',
        bunLastNone: '这个进程还没有发送过推理请求',
        bunHint: 'OpenCode 免费模型会拒绝 Node.js 发出的请求。这个插件使用另外安装的 Bun；OpenCode App 本身不附带可调用的 bun 执行文件。',
        bunMissingHint: '未检测到 Bun。请从 bun.sh 安装，然后按“重新检测”，不需要重启 DSH。',
        bunDownload: '前往下载',
        bunRescan: '重新检测',
        bunRescanning: '检测中…',
        sectionAnonymous: '匿名通道',
        anonOn: '已开启',
        anonOff: '已关闭',
        anonEnable: '不携带我的账号凭证发送推理请求',
        anonWarning: '非官方用法：这会使用公开匿名通道，OpenCode 并未承诺其持续可用。它可能随时失效或被限流，且仍受你的网络出口 IP 限制。请确认能接受风险后再使用。',
        sectionGo: 'OpenCode Go（订阅）',
        goStateDisabled: '已停用',
        goStateUnconfigured: '未配置密钥',
        goStateChecking: '验证中…',
        goStateConnected: '已连接',
        goStateInvalidKey: '密钥无效',
        goStateNoEntitlement: '无 Go 订阅权益',
        goStatePermissionPolicy: '权限或政策受限',
        goStateRateLimited: '速率受限',
        goStateTransient: '暂时故障',
        goStateRedirectBlocked: '已拦截重定向',
        goStateInvalidResponse: '响应格式无效',
        goProviderIdLabel: 'Provider 标识符',
        goCredStatusLabel: 'API 密钥',
        goCredSourceDsh: 'DSH 安全凭证 ({ref})',
        goCredSourceEnv: '环境变量 ({ref})',
        goCredSourceMissing: '未找到 ({ref})',
        goCheckedAt: '上次验证',
        goUsageSummary: '用量窗口',
        goWindowRolling: '5h Limit',
        goWindowWeekly: '7D Limit',
        goWindowMonthly: '1M Limit',
        goWindowResetsAt: '将于 {when} 重置',
        goWindowUnavailable: '–',
        goExtraUsageWarn: '⚠ 若 Console 开启了 Extra Usage，超出订阅额度后可能会扣款工作区余额。',
        goPreviewHint: '已验证的 Go 对话／工具模型会发布到 DSH 选单（仅已实测通过 Go 端点的模型开放图片输入；未验证的图片、影片、推理与非对话协议能力不予开放）。',
        goDisabledHint: '已在插件设置中关闭（goSubscription.enabled: false）。如需启用，请重新开启并通过 DSH 凭证服务或 OPENCODE_GO_API_KEY 提供 OpenCode Console Personal API Key。',
        goRefresh: '重新验证',
        goRefreshing: '验证中…',
        goClear: '清除缓存',
        goPreviewTitle: '工作区模型预览 ({count})',
        goPreviewEmpty: '尚未载入预览模型。',
        goModelTypeUnknown: '类型：未知',
        goContextCap: '上下文 {value}',
        goOutputCap: '输出 {value}',
        goCapReasoning: '推理',
        goCapTools: '工具',
        goCapAttachment: '附件',
        goModalityInput: '输入：{list}',
        goKeyFieldLabel: 'OpenCode Console Personal API Key ({ref})',
        goKeyStoredStatus: '已保存',
        goKeyUnsetStatus: '未设置',
        goKeyStoredPlaceholder: '已保存（输入新密钥即可覆盖）',
        goKeyMissingPlaceholder: '输入 OpenCode Console Personal API Key',
        goKeySave: '保存',
        goKeySaving: '保存中…',
        goKeyChange: '更换密钥',
        goKeyCancel: '取消',
        goKeyDrawer: '密钥',
        goApiOnlyNote: '目前 OpenCode Go 仅支持 Console Personal API Key 授权（不共用免费 OAuth 账号）。',
        goKeyClear: '清除密钥',
        goKeyClearing: '清除中…',
        goKeySavedMsg: '已将 OpenCode Go API key 保存到 DSH 凭证存储。',
        goKeyClearedMsg: '已从 DSH 凭证存储清除 OpenCode Go API key。',
        goKeyWriteUnavailable: '当前 DSH 进程未提供凭证书写接口 (ctx.credentials.set)，无法保存密钥，也不会写入插件配置或 JSON 文件。',
        goFilterAll: '全部',
        goFilterPicker: '可用于选单',
        goFilterPreview: '仅预览',
        goColType: '类型',
        goColOutput: '输出上限',
        goColCaps: '目录能力',
        goStatusInPicker: '已进入选单',
        goStatusPreviewOnly: '仅预览',
        goReasonInactiveStatus: '状态：{status}',
        goReasonMissingType: '缺类型',
        goReasonUnsupportedType: '非对话类型 ({type})',
        goReasonMissingLimits: '缺上限',
        goReasonNonTextModality: '非文字模态',
        goReasonNotConnected: '订阅未连接',
        goReasonInvalidModel: '模型资料无效',
        goReasonIneligible: '未符合正式选单资格',
        goReasonNotVerified: '尚未验证选单资格',
        goPickerEligibleNote: '已验证的 Go 对话模型，自动发布到 DSH 选单（支持文字与工具呼叫；无即时探测或延迟测量）。',
        goPreviewOnlyNote: '目前仅供预览，不会进入 DSH 正式选单：{reasons}。',
        goSupportScopeNote: '目录字段仅代表上游声明；本插件 Go 通道支持文字对话与工具呼叫，并会依据上游目录的 image/image/* 声明自动开放图片输入；不支持影片、音频或其他文件附件。',
        goModelSupportImage: '本插件实际支持：文字对话、工具呼叫与图片输入（依上游目录 image 声明自动开放，实际效果以上游端点为准；不支持影片、音频与文件附件）。',
        goModelSupportTextOnly: '本插件实际支持：仅文字对话与工具呼叫（上游目录未声明支持图片输入，附带图片时将于送出前拒绝）。',
        goCatalogMetaLabel: '目录声明：{meta}',
        goExpandModelId: '模型 ID：{id}',
        goExpandModelName: '显示名称：{name}',
        goExpandProvider: '提供者：{owner}',
        goExpandInputLimit: '输入上限：{value}',
        goExpandModalityIn: '输入模态：{list}',
        goExpandModalityOut: '输出模态：{list}',
        goNoMatch: '没有符合目前筛选条件的 Go 模型。',
        sectionAutoSwitch: '自动切换账号',
        sectionFallback: '模型备用',
        autoSwitchEnable: '确认凭证失效后自动切换账号',
        autoSwitchHint: '默认关闭。仅同一已保存账号刷新后仍收到 401 才切换；限流与网络／模型封锁不会触发。',
        autoSwitchSaved: '自动切换账号设置已保存。',
        fallbackEnable: '模型失败时自动切换到下一顺位',
        fallbackHint: '只在这个模型本身出问题时切换（已下线、已下架、地区限制、超时）。网络被挡或授权失效会直接报告，不会被静默跳过。',
        fallbackSlot: '第 {n} 顺位',
        fallbackNone: '未设置',
        fallbackSave: '保存',
        fallbackSaving: '保存中…',
        fallbackSaved: '备用设置已保存。',
        fallbackOffNote: '备用已关闭。模型失败时会直接返回错误。',
        fallbackNeedProbe: '请先探测模型，才能从可用的模型里选择顺位。',

        rFreeTier: '免费通道拒绝此请求',
        rNetworkBlocked: '网络出口被挡 — 请关闭 VPN/proxy',
        rRegion: '此模型受地区限制',
        rUnauthorized: '授权被拒',
        rForbidden: '上游拒绝（403）',
        rQuota: '额度已用尽',
        rRateLimit: '被限流',
        rUpstream: '上游服务器异常',
        rNotFound: '找不到模型',
        rDeprecated: '模型已下线',
        rUnavailable: '模型当前不可用',
        shortUnavailable: '不可用',
        shortDeprecated: '已下线',
        shortQuota: '额度',
        shortRateLimit: '限流',
        shortRegion: '地区限制',
        shortFreeTier: '通道拒绝',
        shortNetwork: '网络',
        shortTransport: '离线',
        shortNotFound: '未找到',
        shortUpstream: '上游错误',
        shortBadRequest: '请求被拒',
        shortContextOverflow: '超长',
        shortUnauthorized: '未授权',
        shortForbidden: '禁止',
        shortUnknown: '未知',
        rContextOverflow: '内容超过上下文上限',
        rBadRequest: '上游拒绝（400，无说明）',
        rTransport: '连接失败',
        availRatio: '{a}/{b} 个模型可用',
        rUnknown: '未知状态',

        detailProvider: 'Provider 标识符',
        detailVersion: '插件版本',
        detailProbeInterval: '探测间隔',
        detailCatalogPoll: '目录轮询',
        detailPixelBudget: '图像像素预算',
        detailMaxBytes: '图像字节上限',
        detailAutoDetect: '自动检测模型',
        detailGenerated: '状态采样时间',

        on: '开启',
        off: '关闭',
        errorGeneric: '发生错误：{message}',
        loadFailed: '无法读取插件状态。',
        intervalHours: '{h} 小时',
        intervalMinutes: '{m} 分钟',

        /* 语言切换键 */
        languageLabel: '语言',
        languageAuto: '跟随系统',
        languageEn: 'English',
        languageZh: '简体中文',
        languageZhHant: '繁體中文',
        languageOf_en: 'English',
        languageOf_zh: '简体中文',
        'languageOf_zh-Hant': '繁體中文',
      },

      'zh-Hant': {
        nav: 'OpenCode-Next',
        title: 'OpenCode-Next',
        subtitle: '登入授權狀態、這個 provider 提供的模型，以及每個模型最近一次探測的回應。',
        refreshing: '正在重新整理…',
        login: '登入',
        loggingIn: '等待授權中…',
        cancelling: '正在取消…',
        cancelLogin: '取消登入',
        reauth: '重新登入',
        importLocal: '從 OpenCode Desktop 匯入',
        importingLocal: '匯入中…',
        importLocalDone: '已把 OpenCode Desktop 的登入狀態匯入為帳號。',
        importLocalAlready: '這組 OpenCode Desktop 登入已經匯入過。',
        logout: '登出',
        reprobe: '一鍵探測',
        reprobeAvailable: '探測可用 ({n})',
        reprobeFiltered: '探測清單 ({n})',
        probing: '探測中…',
        verify: '重新驗證憑證',

        sectionAccount: '授權狀態',
        sectionAccounts: '帳號', accountAdd: '新增帳號', accountLabel: '帳號標籤', accountLabelPlaceholder: '可選標籤', accountStart: '開始登入', accountCancel: '取消', accountSwitch: '切換', accountActive: '使用中', accountExpired: '已過期', accountExpiry: '剩餘 {time}', accountRemove: '移除', accountRemoveConfirm: '確定移除這個帳號？此動作無法復原。', accountCannotRemoveLast: '至少要保留一個帳號', accountSwitched: '已切換到 {label}', accountNoLabel: '未命名', accountAddHint: '透過裝置授權登入新的 OpenCode 帳號。',
        sectionModels: '模型',
        sectionDetails: '診斷資訊',

        stateReady: '正常',
        stateExpiring: '即將過期',
        stateUnprobed: '尚未探測',
        stateSignedOut: '尚未登入',
        stateExpired: '已過期',
        stateNoModels: '沒有模型回應',
        stateDegraded: '部分模型不可用',
        stateUnknown: '未知',

        hReady: '授權有效，模型可用。',
        hSignedOut: '尚未登入 OpenCode，請先完成裝置授權。',
        hExpired: '授權已過期，請重新登入或重新整理憑證。',
        hNoModels: '授權正常，但目前沒有任何模型回應；可能是免費通道被擋或出口 IP 受限。',
        hDegraded: '授權有效，但並非所有模型都能用；請看下方的分類統計。',
        hUnprobed: '授權正常，尚未探測模型可用性。',
        hExpiring: '授權即將到期，系統會自動重新整理。',

        credAbsent: '沒有憑證',
        credSource: '來源',
        credExpiry: '到期',
        credRefreshable: '自動更新',
        credYes: '可用',
        credNo: '不可用',
        srcAccounts: '已登入帳號',
        srcLocalDb: 'OpenCode Desktop 資料庫',
        srcAuthJson: 'OpenCode auth.json',
        srcTokenFile: '本外掛儲存',
        srcUnknown: '未知來源',

        expiresIn: '剩餘 {time}',
        expiresAt: '於 {when}',
        expiresPast: '已過期',
        expiresNoExpiry: '未回報到期時間',

        signedOutHint: '尚未取得 OpenCode 憑證。可在下方登入，或以 OpenCode Desktop 登入後由本外掛自動沿用其 token。',
        loginHint: '開啟下列網址，並確認網頁上顯示的代碼與此相同：',
        userCode: '代碼',
        openAgain: '再次開啟登入頁',
        waiting: '應該已開啟瀏覽器視窗，請在該頁面同意授權；本頁會自動更新。',
        loginCancelled: '這次登入已取消，因為你已登出。準備好時再重新開始即可。',
        loginFailed: '登入沒有完成：{message}',
        loginFailedTimeout: '登入逾時。準備好時再重新開始即可。',
        loginFailedDenied: '授權被拒絕。若仍要連線，請重新開始登入。',
        loginFailedExpired: '這組登入代碼已過期。請重新開始以取得新的代碼。',
        loginFailedNetwork: '連不到 OpenCode。請檢查網路後再試一次。',
        copy: '複製',
        copied: '已複製',

        modelsAvailable: '{total} 個中有 {ok} 個有回應',
        filterAll: '全部',
        filterAvailable: '可用',
        filterCount: '顯示 {shown}／{total}',
        rowDetails: '展開探測細節與上下文大小',
        modelFilters: '依模型可用狀態或探測結果篩選',
        probedAgo: '上次探測：{when}（手動）',
        neverProbed: '尚未探測（手動模式）',
        truncatedRateLimit: '本輪只驗了 {tested}/{total}：某個模型遇到限流或額度用盡就停手。未驗的模型保留上次結果。',
        truncatedUnreachable: '本輪只驗了 {tested}/{total}：免費通道中斷。未驗的模型保留上次結果。',
        quotaReset: '免費額度將於 {when} 重置（還有 {in}）。',
        quotaResetReady: '免費額度視窗已重置，可以重新探測或對話。',
        quotaResetUnknown: '免費額度已用盡；上游沒有說明何時重置。',
        colModel: '模型',
        colStatus: '狀態',
        colContext: '上下文',
        colLatency: '延遲',
        statusOk: '正常',
        statusFail: '不可用',
        statusLimited: '受限',
        statusUnprobed: '未探測',
        pickerAvailable: '在模型清單中',
        pickerHidden: '已從模型清單隱藏',
        colPicker: '顯示',
        pickerShow: '在模型清單中顯示',
        pickerManual: '手動挑選 — 顯示 {n}/{total} 個，新模型不再自動出現。',
        pickerAuto: '自動 — 所有通過驗證的模型都會顯示。',
        pickerReset: '顯示全部可用模型',
        pickerResetBusy: '還原中…',
        pickerAutoShort: '自動',
        pickerManualShort: '手選',
        modelProbedAt: '探測時間：{when}',
        modelFailureStreak: '連續失敗 {count}/2 次',
        modelsCaption: '可用狀態',
        tabAccount: '帳號',
        tabModels: '免費模型',
        tabAdvanced: '進階',
        tabGo: 'OpenCode Go',
        unitDay: '天',
        unitHour: '小時',
        unitMinute: '分',
        unitLessThanMinute: '不到 1 分鐘',
        showAll: '顯示全部 {n} 個模型',
        showRest: '顯示其餘 {n} 個（共 {total} 個）',
        showLess: '顯示較少',
        onlyProblems: '只看有問題的',
        searchPlaceholder: '篩選模型',
        noMatch: '沒有符合的模型。',
        contextSummary: '上下文大小：{effective} tokens · {source}',
        contextSetting: '上下文大小',
        contextMode: '容量來源',
        contextDefault: '跟隨 OpenCode 預設值',
        contextCustom: '自訂數值',
        contextPublished: '目錄／預設值：{value} tokens',
        contextSourceOpenCode: 'OpenCode 模型目錄',
        contextSourceFallback: '外掛備援值',
        contextSourceCustom: '手動覆寫',
        contextValue: '上下文大小（tokens）',
        contextHint: '此數值只會改變 DSH 的模型預算，不會提高 OpenCode 的實際上限，也不會改變 DSH 的壓縮策略。',
        contextSave: '儲存',
        contextSaving: '儲存中…',
        contextReset: '恢復預設值',
        contextSaved: '上下文設定已儲存。',
        contextInvalid: '請輸入 1,024 到 100,000,000 之間的整數。',
        contextClickToEdit: '按一下設定上下文上限',
        contextModalTitle: '設定上下文上限',
        contextModalSub: '模型：{id}',
        contextDefaultValue: '上游預設值：{value} tokens',
        contextMaxOutput: '單次回覆輸出上限：{value} tokens',
        contextCustomLabel: '自訂上限（tokens）',
        contextResetToDefault: '恢復預設值',
        contextCancel: '取消',
        contextSaveBtn: '儲存',
        contextCustomBadge: '自訂',

        sectionAdvanced: '進階設定',
        sectionBun: 'Bun 執行環境',
        bunInstalled: '已偵測到',
        bunMissing: '未安裝',
        bunVersion: '版本',
        bunPath: '執行檔',
        bunEnabled: '推論傳輸',
        bunUsed: 'Bun',
        bunNode: 'Node.js',
        bunLast: '最近一次請求',
        bunLastNone: '這個行程還沒有送出推論請求',
        bunHint: 'OpenCode 免費模型會拒絕 Node.js 發出的請求。這個外掛使用另外安裝的 Bun；OpenCode App 本身不附帶可呼叫的 bun 執行檔。',
        bunMissingHint: '未偵測到 Bun。請從 bun.sh 安裝，然後按「重新檢測」，不需要重啟 DSH。',
        bunDownload: '前往下載',
        bunRescan: '重新檢測',
        bunRescanning: '檢測中…',
        sectionAnonymous: '匿名通道',
        anonOn: '已開啟',
        anonOff: '已關閉',
        anonEnable: '不攜帶我的帳號憑證送出推論請求',
        anonWarning: '非官方用法：這會使用公開匿名通道，OpenCode 並未承諾其持續可用。它可能隨時失效或被限流，且仍受你的網路出口 IP 限制。請確認能接受風險後再使用。',
        sectionGo: 'OpenCode Go（訂閱）',
        goStateDisabled: '已停用',
        goStateUnconfigured: '未設定密鑰',
        goStateChecking: '驗證中…',
        goStateConnected: '已連線',
        goStateInvalidKey: '密鑰無效',
        goStateNoEntitlement: '無 Go 訂閱權益',
        goStatePermissionPolicy: '權限或政策受限',
        goStateRateLimited: '速率受限',
        goStateTransient: '暫時故障',
        goStateRedirectBlocked: '已攔截重新導向',
        goStateInvalidResponse: '回應格式無效',
        goProviderIdLabel: 'Provider 識別碼',
        goCredStatusLabel: 'API 密鑰',
        goCredSourceDsh: 'DSH 安全憑證 ({ref})',
        goCredSourceEnv: '環境變數 ({ref})',
        goCredSourceMissing: '未找到 ({ref})',
        goCheckedAt: '上次驗證',
        goUsageSummary: '用量視窗',
        goWindowRolling: '5h Limit',
        goWindowWeekly: '7D Limit',
        goWindowMonthly: '1M Limit',
        goWindowResetsAt: '將於 {when} 重設',
        goWindowUnavailable: '–',
        goExtraUsageWarn: '⚠ 若 Console 開啟 Extra Usage，超出訂閱額度後可能會扣款工作區餘額。',
        goPreviewHint: '已驗證的 Go 對話／工具模型會發佈到 DSH 選單（僅已實測通過 Go 端點的模型開放圖片輸入；未驗證的圖片、影片、推理與非對話協定能力不予開放）。',
        goDisabledHint: '已在外掛設定中停用（goSubscription.enabled: false）。如需啟用，請重新開啟並透過 DSH 憑證服務或 OPENCODE_GO_API_KEY 提供 OpenCode Console Personal API Key。',
        goRefresh: '重新驗證',
        goRefreshing: '驗證中…',
        goClear: '清除快取',
        goPreviewTitle: '工作區模型預覽 ({count})',
        goPreviewEmpty: '尚未載入預覽模型。',
        goModelTypeUnknown: '類型：未知',
        goContextCap: '上下文 {value}',
        goOutputCap: '輸出 {value}',
        goCapReasoning: '推理',
        goCapTools: '工具',
        goCapAttachment: '附件',
        goModalityInput: '輸入：{list}',
        goKeyFieldLabel: 'OpenCode Console Personal API Key ({ref})',
        goKeyStoredStatus: '已儲存',
        goKeyUnsetStatus: '未設定',
        goKeyStoredPlaceholder: '已儲存（輸入新金鑰即可覆蓋）',
        goKeyMissingPlaceholder: '輸入 OpenCode Console Personal API Key',
        goKeySave: '儲存',
        goKeySaving: '儲存中…',
        goKeyChange: '更換金鑰',
        goKeyCancel: '取消',
        goKeyDrawer: '金鑰',
        goApiOnlyNote: '目前 OpenCode Go 僅支援 Console Personal API Key 授權（不共用免費 OAuth 帳號）。',
        goKeyClear: '清除金鑰',
        goKeyClearing: '清除中…',
        goKeySavedMsg: '已將 OpenCode Go API key 儲存至 DSH 憑證服務。',
        goKeyClearedMsg: '已從 DSH 憑證服務清除 OpenCode Go API key。',
        goKeyWriteUnavailable: '目前 DSH 行程未提供憑證寫入介面 (ctx.credentials.set)，無法儲存金鑰，也不會寫入外掛設定或 JSON 檔案。',
        goFilterAll: '全部',
        goFilterPicker: '可用於選單',
        goFilterPreview: '僅預覽',
        goColType: '類型',
        goColOutput: '輸出上限',
        goColCaps: '目錄能力',
        goStatusInPicker: '已進入選單',
        goStatusPreviewOnly: '僅預覽',
        goReasonInactiveStatus: '狀態：{status}',
        goReasonMissingType: '缺類型',
        goReasonUnsupportedType: '非對話類型 ({type})',
        goReasonMissingLimits: '缺上限',
        goReasonNonTextModality: '非文字模態',
        goReasonNotConnected: '訂閱未連線',
        goReasonInvalidModel: '模型資料無效',
        goReasonIneligible: '未符合正式選單資格',
        goReasonNotVerified: '尚未驗證選單資格',
        goPickerEligibleNote: '已驗證的 Go 對話模型，自動發佈到 DSH 選單（支援文字與工具呼叫；無即時探測或延遲測量）。',
        goPreviewOnlyNote: '目前僅供預覽，不會進入 DSH 正式選單：{reasons}。',
        goSupportScopeNote: '目錄欄位僅代表上游宣告；本外掛 Go 通道支援文字對話與工具呼叫，並會依上游目錄的 image/image/* 宣告自動開放圖片輸入；不支援影片、音訊或其他檔案附件。',
        goModelSupportImage: '本外掛實際支援：文字對話、工具呼叫與圖片輸入（依上游目錄 image 宣告自動開放，實際可否辨識以上游端點為準；不支援影片、音訊與檔案附件）。',
        goModelSupportTextOnly: '本外掛實際支援：僅文字對話與工具呼叫（上游目錄未宣告圖片輸入，附帶圖片時將於送出前拒絕）。',
        goCatalogMetaLabel: '目錄宣告：{meta}',
        goExpandModelId: '模型 ID：{id}',
        goExpandModelName: '顯示名稱：{name}',
        goExpandProvider: '提供者：{owner}',
        goExpandInputLimit: '輸入上限：{value}',
        goExpandModalityIn: '輸入模態：{list}',
        goExpandModalityOut: '輸出模態：{list}',
        goNoMatch: '沒有符合目前篩選條件的 Go 模型。',
        sectionAutoSwitch: '自動切換帳號',
        sectionFallback: '模型備援',
        autoSwitchEnable: '確認憑證失效後自動切換帳號',
        autoSwitchHint: '預設關閉。僅同一個已儲存帳號刷新後仍收到 401 才切換；限流與網路／模型封鎖不會觸發。',
        autoSwitchSaved: '自動切換帳號設定已儲存。',
        fallbackEnable: '模型失敗時自動切換到下一順位',
        fallbackHint: '只在「這個模型自己出問題」時切換（已下線、已下架、地區限制、逾時）。網路被擋或授權失效會直接回報，不會被靜默跳過。',
        fallbackSlot: '第 {n} 順位',
        fallbackNone: '未設定',
        fallbackSave: '儲存',
        fallbackSaving: '儲存中…',
        fallbackSaved: '備援設定已儲存。',
        fallbackOffNote: '備援已關閉。模型失敗時會直接回傳錯誤。',
        fallbackNeedProbe: '請先探測模型，才能從可用的模型裡選擇順位。',

        rFreeTier: '免費通道拒絕此請求',
        rNetworkBlocked: '網路出口被擋 — 請關閉 VPN／proxy',
        rRegion: '此模型受地區限制',
        rUnauthorized: '授權遭拒',
        rForbidden: '上游拒絕（403）',
        rQuota: '額度已用盡',
        rRateLimit: '被限流',
        rUpstream: '上游伺服器異常',
        rNotFound: '找不到模型',
        rDeprecated: '模型已下架',
        rUnavailable: '模型目前不可用',
        shortUnavailable: '不可用',
        shortDeprecated: '已下架',
        shortQuota: '額度',
        shortRateLimit: '限流',
        shortRegion: '地區限制',
        shortFreeTier: '通道拒絕',
        shortNetwork: '網路',
        shortTransport: '離線',
        shortNotFound: '未找到',
        shortUpstream: '上游錯誤',
        shortBadRequest: '請求被拒',
        shortContextOverflow: '超長',
        shortUnauthorized: '未授權',
        shortForbidden: '禁止',
        shortUnknown: '未知',
        rContextOverflow: '內容超過上下文上限',
        rBadRequest: '上游拒絕（400，無說明）',
        rTransport: '連線失敗',
        availRatio: '{a}/{b} 個模型可用',
        rUnknown: '未知狀態',

        detailProvider: 'Provider 識別碼',
        detailVersion: '外掛版本',
        detailProbeInterval: '探測間隔',
        detailCatalogPoll: '目錄輪詢',
        detailPixelBudget: '圖片像素預算',
        detailMaxBytes: '圖片位元組上限',
        detailAutoDetect: '自動偵測模型',
        detailGenerated: '狀態取樣時間',

        on: '開啟',
        off: '關閉',
        errorGeneric: '發生錯誤：{message}',
        loadFailed: '無法讀取外掛狀態。',
        intervalHours: '{h} 小時',
        intervalMinutes: '{m} 分鐘',

        /* 語言切換鍵 */
        languageLabel: '語言',
        languageAuto: '跟隨系統',
        languageEn: 'English',
        languageZh: '简体中文',
        languageZhHant: '繁體中文',
        languageOf_en: 'English',
        languageOf_zh: '简体中文',
        'languageOf_zh-Hant': '繁體中文',
      }
    };

    /* --------------------------------------------------------------- 工具 */

    /* --------------------------------------------------------- 語言選擇

       四個選項：跟隨系統、English、簡體中文、繁體中文。

       為什麼不直接用宿主的 `ctx.locale.bind()`：那個 translator 走的是
       `fallbackChain(snapshot.active)`，而 `snapshot.active` 是**全域** DSH 語言。
       用它就等於「切換語言時整個 DSH 都跟著變」，而且 `setLocale()` 會把選擇
       寫進 DSH 使用者設定。本外掛要的是「只改自己這一頁」，所以自己維護一份
       語言狀態，完全不碰宿主偏好。

       註：這裡刻意把「簡體中文」寫成繁體字。字典裡的值必須是簡體（那是資料），
       但程式碼與註解一律繁體——專案有自動掃描在盯這件事。 */

    /** 語言偏好的儲存鍵（存在外掛自己的檔案，不是 DSH 設定）。 */
    const LANG_STORAGE_KEY = 'opencode-next.language';

    /** 切換鍵的四個選項。`auto` 代表跟隨系統。 */
    const LANGUAGE_OPTIONS = [
      { id: 'auto', label: 'languageAuto' },
      { id: 'en', label: 'languageEn' },
      { id: 'zh', label: 'languageZh' },
      { id: 'zh-Hant', label: 'languageZhHant' }
    ];

    const SUPPORTED_LOCALES = ['en', 'zh', 'zh-Hant'];

    /**
     * 把一個 BCP 47 標籤（例如 `zh-TW`、`zh-Hant-HK`、`en-US`）對應到支援的語言。
     *
     * 順序刻意是「先看繁中線索」：`zh-Hant-TW`、`zh-TW`、`zh-HK`、`zh-MO` 都算繁中；
     * 其餘 `zh-*`（`zh-CN`、`zh-SG`、單純 `zh`）算簡中；非中文一律英文。
     *
     * 為什麼繁中要先判斷：`zh-Hant-TW` 若先比對主標籤 `zh` 就會被誤判成簡中。
     *
     * @param {string} tag 語言標籤；可為空。
     * @returns {'en'|'zh'|'zh-Hant'|null} 對應的語言 id；非中英文時回 `null`，
     *   代表「讀到了，但不在支援範圍」，由呼叫端決定要退到哪個語言。
     */
    function localeFromTag(tag) {
      const low = String(tag ?? '').toLowerCase();
      if (low.startsWith('zh')) {
        if (/hant|-tw|-hk|-mo/.test(low)) return 'zh-Hant';
        return 'zh';
      }
      if (low.startsWith('en')) return 'en';
      // 日文、德文等：不支援，而且不該被當成「英文使用者」。
      return null;
    }

    /**
     * 決定這一頁要用哪個語言。
     *
     * 優先順序：
     *   1. 使用者明確選過（存下來的那個）→ 用它
     *   2. 選「跟隨系統」（或從未選過）→ 用主機端讀到的系統語言
     *   3. 系統語言讀不到，或**不屬於支援的語言**（例如日文、德文）
     *      → 繁體中文（使用者的偏好語言）
     *
     * 第 3 點是刻意的：系統是日文時，顯示中文還是英文都算「猜」，但使用者的
     * 環境是中文，退到中文比退到英文更貼近實際情況。真要英文的話，切換鍵
     * 就在同一頁，一次點擊即可。
     *
     * 系統語言由主機端提供（`status.systemLocale`），而不是讀 `navigator.language`：
     * 實測遇過 Windows 是 `zh-TW` 但 Chrome 把 `en-US` 排第一的情況，跟瀏覽器
     * 會得到英文，不是使用者的介面語言。
     *
     * @param {string|null} stored 儲存的偏好（`auto` 或某個語言 id）。
     * @param {string|null} systemLocale 主機端讀到的系統語言標籤。
     * @returns {'en'|'zh'|'zh-Hant'}
     */
    function resolveLocale(stored, systemLocale) {
      if (stored && SUPPORTED_LOCALES.includes(stored)) return stored;
      // stored 是 'auto'、null 或任何不認得的值 → 跟隨系統。
      if (typeof systemLocale === 'string' && systemLocale) {
        const mapped = localeFromTag(systemLocale);
        if (mapped && SUPPORTED_LOCALES.includes(mapped)) return mapped;
      }
      // 讀不到，或系統語言不在支援範圍 → 預設繁體中文。
      return 'zh-Hant';
    }

    /** 讀取儲存的語言偏好。localStorage 不可用時安靜地回傳 null。 */
    function readStoredLanguage() {
      try {
        const raw = window.localStorage.getItem(LANG_STORAGE_KEY);
        if (raw === null) return null;
        if (raw === 'auto' || SUPPORTED_LOCALES.includes(raw)) return raw;
        return null;
      } catch {
        return null;
      }
    }

    /** 模型分類篩選的儲存鍵。 */
    const FILTER_STORAGE_KEY = 'opencode-next.model-filter';

    function readStoredFilter() {
      try {
        const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
        if (typeof raw === 'string' && raw.trim()) return raw.trim();
        return null;
      } catch {
        return null;
      }
    }

    function writeStoredFilter(value) {
      try {
        if (typeof value === 'string' && value) {
          window.localStorage.setItem(FILTER_STORAGE_KEY, value);
        } else {
          window.localStorage.removeItem(FILTER_STORAGE_KEY);
        }
        return true;
      } catch {
        return false;
      }
    }

    /** 寫入語言偏好。失敗（例如無痕模式）不影響畫面。 */
    function writeStoredLanguage(value) {
      try {
        window.localStorage.setItem(LANG_STORAGE_KEY, value);
        return true;
      } catch {
        return false;
      }
    }

    function translator(locale) {
      const table = COPY[locale] ?? COPY.en;
      const lookup = (obj, key) =>
        key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), obj);
      return (key, vars) => {
        const text = String(lookup(table, key) ?? lookup(COPY.en, key) ?? key);
        return vars
          ? text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
          : text;
      };
    }

    async function callApi(pathname, method = 'GET', body) {
      const res = await fetch(`${API}/${pathname}`, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!data.ok) {
        const error = new Error(data.message || data.error || `HTTP ${res.status}`);
        error.code = data.error;
        throw error;
      }
      return data.value;
    }

    /**
     * 剩餘時間的人話版本。
     *
     * 原本回傳 "26d 15h"、"41m" 這種英文單位，混在整頁中文裡非常突兀
     * （截圖上「剩餘 26d 15h」就夾在「剩餘 27d 16h」旁邊）。改成呼叫端傳入的
     * 單位字串，讓每個語言用自己的寫法。
     *
     * 保留 `shortDuration` 這個名字與數值邏輯：單位只是最後一層包裝。
     */
    function shortDuration(ms, units) {
      if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–';
      const negative = ms < 0;
      const abs = Math.abs(ms);
      const minutes = Math.floor(abs / 60000);
      const u = units ?? { d: 'd', h: 'h', m: 'm', lessThanMinute: '<1m' };
      let out;
      if (minutes < 1) out = u.lessThanMinute;
      else if (minutes < 60) out = `${minutes}${u.m}`;
      else {
        const hours = Math.floor(minutes / 60);
        if (hours < 48) out = minutes % 60 ? `${hours}${u.h} ${minutes % 60}${u.m}` : `${hours}${u.h}`;
        else {
          const days = Math.floor(hours / 24);
          out = hours % 24 ? `${days}${u.d} ${hours % 24}${u.h}` : `${days}${u.d}`;
        }
      }
      return negative ? `-${out}` : out;
    }

    function formatWhen(ms, localeId) {
      if (!ms) return null;
      const intl = localeId === 'en' ? 'en' : localeId === 'zh-Hant' ? 'zh-TW' : 'zh-CN';
      try {
        return new Intl.DateTimeFormat(intl, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }).format(new Date(ms));
      } catch {
        return new Date(ms).toLocaleString();
      }
    }

    /** 把探測結果的內部 reason 轉成當前語言的說明。 */
    function reasonKey(reason) {
      switch (reason) {
        // 放在最前面：這是最容易被誤讀成「換模型就好」的一種失敗。
        // 它擋的是整個網路出口，換任何模型都會拿到同一段訊息。
        case 'network-blocked':
          return 'rNetworkBlocked';
        case 'free-lane-blocked':
          return 'rFreeTier';
        case 'region-restricted':
          return 'rRegion';
        case 'unauthorized':
          return 'rUnauthorized';
        case 'forbidden':
          return 'rForbidden';
        case 'quota-exceeded':
          return 'rQuota';
        case 'rate-limited':
        case 'rate-limited-explicit':
        case 'endpoint-unavailable':
          return 'rRateLimit';
        case 'upstream-error':
          return 'rUpstream';
        case 'not-found':
          return 'rNotFound';
        case 'deprecated':
          return 'rDeprecated';
        case 'unavailable':
          return 'rUnavailable';
        // 400 的三種分支各有各的處置，不可共用一個標籤：
        //   上下文超限 → 縮短訊息（模型好好的）
        //   模型不可用 → 換模型
        //   沒有說明   → 上游只回模型名稱，多半是帳號在該模型上的權限／額度
        case 'context-overflow':
          return 'rContextOverflow';
        case 'bad-request':
          return 'rBadRequest';
        case 'transport':
          return 'rTransport';
        default:
          return null;
      }
    }

    /**
     * 分段選單用的短標籤。
     *
     * 篩選列是「一排等寬格子」，而失敗原因的完整句子（「模型目前不可用」）
     * 比「可用」長三倍；同一排混用長短標籤，格寬就會參差、選中項也會跟著
     * 變寬，看起來像一個塞錯地方的輸入框。這裡給每個原因一個短名詞，
     * 完整句子仍然留在表格列的狀態底下。
     */
    function shortReasonKey(reason) {
      switch (reason) {
        case 'network-blocked': return 'shortNetwork';
        case 'free-lane-blocked': return 'shortFreeTier';
        case 'region-restricted': return 'shortRegion';
        case 'unauthorized': return 'shortUnauthorized';
        case 'forbidden': return 'shortForbidden';
        case 'quota-exceeded': return 'shortQuota';
        case 'rate-limited':
        case 'rate-limited-explicit':
        case 'endpoint-unavailable': return 'shortRateLimit';
        case 'upstream-error': return 'shortUpstream';
        case 'not-found': return 'shortNotFound';
        case 'deprecated': return 'shortDeprecated';
        case 'unavailable': return 'shortUnavailable';
        case 'context-overflow': return 'shortContextOverflow';
        case 'bad-request': return 'shortBadRequest';
        case 'transport': return 'shortTransport';
        default: return null;
      }
    }

    function healthChip(health) {
      switch (health) {
        case 'ready':
          return { tone: 'ok', key: 'stateReady' };
        case 'expiring':
          return { tone: 'warn', key: 'stateExpiring' };
        case 'unprobed':
          return { tone: 'warn', key: 'stateUnprobed' };
        case 'signed-out':
          return { tone: 'off', key: 'stateSignedOut' };
        case 'expired':
          return { tone: 'off', key: 'stateExpired' };
        case 'no-models':
          return { tone: 'off', key: 'stateNoModels' };
        // 部分模型可用：黃燈。
        //
        // 這是舊版最大的盲點——只要還有 1 個模型活著就亮綠燈，於是 45 個壞 34 個
        // 的時候畫面看起來一切正常。黃燈的意義是「能用，但別當成沒事」。
        case 'degraded':
          return { tone: 'warn', key: 'stateDegraded' };
        default:
          return { tone: 'warn', key: 'stateUnknown' };
      }
    }

    /**
     * 健康狀態那句話的翻譯鍵。
     *
     * 宿主回傳的 `healthMessage` 是一句固定的中文（status.js 不知道瀏覽器當下用
     * 什麼語言），所以英文介面若直接顯示它就會變成中英夾雜。這裡改成用 `health`
     * 這個穩定的代碼去查本地字典；只有遇到不認識的代碼時才退回宿主的字串。
     */
    function healthMessageKey(health) {
      switch (health) {
        case 'ready':
          return 'hReady';
        case 'signed-out':
          return 'hSignedOut';
        case 'expired':
          return 'hExpired';
        case 'no-models':
          return 'hNoModels';
        case 'degraded':
          return 'hDegraded';
        case 'unprobed':
          return 'hUnprobed';
        case 'expiring':
          return 'hExpiring';
        default:
          return null;
      }
    }

    /* --------------------------------------------------------------- 樣式 */

    function installStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      // 只使用宿主的主題別名變數（label-*、bg-layer-*、border-l*、state-*），
      // 這樣淺色／深色會自動跟著切換，而不是把顏色寫死。三個 state token 後面
      // 的字面值只是狀態色的保險絲：別名不存在時至少還看得出紅／黃／綠。
      style.textContent = `
        .ocoa-page {
          /* 顏色全部取自宿主實際存在的別名變數（已對 app.asar 逐項核對）。
             原本用的 accent-primary 與 label-on-accent 在宿主裡根本不存在，
             於是主按鈕與選中項的底色是透明的、文字又是白色——看起來就是
             「消失的按鈕」。這兩個已經換成 business-primary 系列。 */
          --ocoa-fg: var(--dsw-alias-label-primary, #0f1115);
          --ocoa-fg2: var(--dsw-alias-label-secondary, #61666b);
          --ocoa-fg3: var(--dsw-alias-label-tertiary, #81858c);
          /* 宿主把 bg-layer-1/2/3 都設成同一個白色，直接拿來堆疊會完全沒有層次。
             所以表面色用純白，內凹／表頭改用淺藍灰（bluish-100/200）。 */
          --ocoa-surface: var(--dsw-alias-bg-layer-1, #fff);
          --ocoa-sunk: var(--dsw-static-neutral-bluish-100, #ebeef2);
          --ocoa-sunk2: var(--dsw-static-neutral-bluish-200, #e1e5ee);
          --ocoa-line: var(--dsw-alias-border-l1, #0000000a);
          --ocoa-line2: var(--dsw-alias-border-l2, #0000001a);
          --ocoa-line3: var(--dsw-alias-border-l3, #0000001f);
          /* 強調色：宿主沒有 accent-primary。button-primary-fill 在淺色主題下
             指向 state-error-primary（紅色），拿來當主要動作色會像警告，所以改用
             state-business-primary（DeepSeek 藍 #4176e6）——它是中性強調色。 */
          --ocoa-accent: var(--dsw-alias-state-business-primary, #4176e6);
          --ocoa-on-accent: var(--dsw-alias-bg-layer-1, #fff);
          --ocoa-hover: var(--dsw-alias-interactive-bg-hover, #f3f4f6);
          --ocoa-ok: var(--dsw-alias-state-success-primary, #22c55e);
          --ocoa-off: var(--dsw-alias-state-error-primary, #ec1313);
          /* 宿主叫 state-warn-*，不是 state-warning-*。寫錯就整個警告色失效。 */
          --ocoa-warn: var(--dsw-alias-state-warn-label, #dd8629);
          --ocoa-mono: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace;

          /* 間距級距。整頁只用這五個值，不再出現 7px / 9px / 13px 這種散落的
             任意數字——那正是原本看起來「哪裡怪怪的、說不出哪裡」的原因。 */
          --ocoa-s1: 4px;
          --ocoa-s2: 8px;
          --ocoa-s3: 16px;
          --ocoa-s4: 24px;
          --ocoa-s5: 32px;

          display: flex; flex-direction: column;
          /* 這是工作面板，不是展示頁。區塊之間 12px 就分得開，
             再拉到 24px 只是讓眼睛多走一趟，不會比較精緻。 */
          gap: 12px;
          padding: 16px 20px;
          min-width: 0; box-sizing: border-box;
          color: var(--ocoa-fg);
          background-color: var(--ocoa-surface);
          border: 1px solid var(--ocoa-line2);
          border-radius: 12px;
          line-height: 1.4;
          -webkit-font-smoothing: antialiased;
        }
        /* 所有子元素都吃 border-box：卡片內距 + 邊框若用 content-box 計算，
           在固定寬度的面板裡會把右緣推出邊界（實測截圖就是這樣）。 */
        .ocoa-page *, .ocoa-page *::before, .ocoa-page *::after { box-sizing: border-box; }
        .ocoa-head { display: flex; flex-direction: column; gap: var(--ocoa-s2); }

        /* 分頁籤：底線式，不用藥丸。
           這是頁面內的分頁，不是主要動作；藥丸會跟下面的篩選按鈕撞在一起，
           看起來像同一層級的控制項。 */
        .ocoa-tabs {
          display: flex; gap: var(--ocoa-s1); flex-wrap: wrap;
          border-bottom: 1px solid var(--ocoa-line2);
          margin: var(--ocoa-s1) 0 0;
        }
        .ocoa-tab {
          appearance: none; font: inherit; cursor: pointer;
          display: inline-flex; align-items: center; gap: 6px;
          padding: 6px 12px 7px;
          border: 0; background: none;
          color: var(--ocoa-fg2); font-size: 13px; font-weight: 500;
          border-bottom: 2px solid transparent;
          margin-bottom: -1px; white-space: nowrap;
          transition: color .13s ease, border-color .13s ease;
        }
        .ocoa-tab:hover { color: var(--ocoa-fg); }
        .ocoa-tab:focus-visible { outline: 2px solid var(--ocoa-accent); outline-offset: -2px; }
        .ocoa-tab.is-active { color: var(--ocoa-fg); font-weight: 600; border-bottom-color: var(--ocoa-accent); }
        .ocoa-tab-badge {
          font-variant-numeric: tabular-nums; font-size: 11px; font-weight: 600;
          min-width: 18px; text-align: center;
          padding: 1px 6px; border-radius: 999px; line-height: 1.5;
          background: var(--ocoa-sunk); color: var(--ocoa-fg2);
        }
        .ocoa-tab.is-active .ocoa-tab-badge { background: var(--ocoa-sunk2); color: var(--ocoa-fg); }
        .ocoa-pane { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
        .ocoa-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .ocoa-title { font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
        /* 副標題：只給「這頁在講什麼」一句話。行高放寬、寬度收窄，
           讓長句斷在自然的逗號處，而不是橫貫整頁。 */
        .ocoa-sub {
          font-size: 12.5px; color: var(--ocoa-fg3);
          line-height: 1.65; max-width: 62ch;
        }
        .ocoa-msg { font-size: 12.5px; color: var(--ocoa-fg2); line-height: 1.55; }
        /* 探測被熔斷的說明。用警示色而不是一般灰字：它講的是「這次只驗了一部分」，
           錯過它就會把 13/4 讀成完整結果。 */
        .ocoa-msg-warn { color: var(--ocoa-warn, #b45309); }

        /* 分類篩選：淺灰底的分段控制。
           選中項用「白底 + 內縮一圈細框」而不是浮起的陰影——陰影會讓它看起來
           像浮在控制項外面的輸入框，尤其當它又剛好比較寬時（截圖上就是這樣）。
           現在它仍在灰底之內，只是被「挖出來」，不會脫離那一條。 */
        .ocoa-segments {
          display: flex; gap: 2px; min-width: 0;
          padding: 3px; border-radius: 10px;
          background: var(--ocoa-sunk);
          overflow-x: auto; overflow-y: hidden;
          scrollbar-width: none;
        }
        .ocoa-segments::-webkit-scrollbar { display: none; }
        .ocoa-seg {
          appearance: none; font: inherit; cursor: pointer;
          display: inline-flex; align-items: baseline; gap: 6px;
          flex: 1 1 0; justify-content: center;
          padding: 5px 8px; min-width: 0; border-radius: 7px;
          font-size: 12px; color: var(--ocoa-fg2);
          background: transparent; border: 0;
          white-space: nowrap;
          transition: background .13s ease, color .13s ease;
        }
        .ocoa-seg:hover { color: var(--ocoa-fg); }
        .ocoa-seg:focus-visible { outline: 2px solid var(--ocoa-accent); outline-offset: -2px; }
        .ocoa-seg-count {
          font-variant-numeric: tabular-nums; font-weight: 650;
          color: var(--ocoa-fg); font-size: 13px;
        }
        /* 選中項：白底，但只用極淡的內框界定，不做陰影。 */
        .ocoa-seg.is-active {
          background: var(--ocoa-surface);
          color: var(--ocoa-fg);
          box-shadow: inset 0 0 0 1px var(--ocoa-line3);
        }
        .ocoa-seg.is-active .ocoa-seg-count { color: inherit; }
        /* 未選取時只有「可用」帶綠色；其餘一律灰字，紅色留給表格裡真正的失敗列。 */
        .ocoa-seg.is-ok:not(.is-active) .ocoa-seg-count { color: var(--ocoa-ok); }
        .ocoa-toolbar-count {
          margin-left: auto; font-size: 12px; color: var(--ocoa-fg3);
          font-variant-numeric: tabular-nums;
        }

        .ocoa-chip {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
          border: 1px solid var(--ocoa-line2); color: var(--ocoa-fg2);
          background: var(--ocoa-surface);
        }
        .ocoa-chip-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
        .ocoa-chip.ok { color: var(--ocoa-ok); border-color: color-mix(in srgb, var(--ocoa-ok) 40%, transparent); }
        .ocoa-chip.warn { color: var(--ocoa-warn); border-color: color-mix(in srgb, var(--ocoa-warn) 40%, transparent); }
        .ocoa-chip.off { color: var(--ocoa-off); border-color: color-mix(in srgb, var(--ocoa-off) 40%, transparent); }

        /* 卡片：只留一層淡邊框。原本每張卡都有邊框 + 內距 + 表頭底線，
           三層一起看就像一堆盒子疊起來——現在靠留白分組，不靠框線。 */
        .ocoa-card {
          background: var(--ocoa-surface);
          border: 1px solid var(--ocoa-line2);
          border-radius: 10px;
          padding: 12px 14px;
          display: flex; flex-direction: column; gap: 10px;
          min-width: 0;
        }
        .ocoa-card-head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 8px; flex-wrap: wrap; min-width: 0;
        }
        /* 卡片標題用正常字重與深色，而不是灰字：它是區塊的門牌。 */
        .ocoa-card-title {
          font-size: 14px; font-weight: 600; letter-spacing: -.005em;
          color: var(--ocoa-fg);
        }
        /* 次區塊標題：同一張卡裡放兩件事時（例如進階裡的備援與診斷），
           用比卡片標題小一級的灰字分隔，避免為了兩個小設定再開一張卡。 */
        /* 次區塊標題：同一張卡裡放兩件事時（例如進階裡的備援與診斷），
           用比卡片標題小一級的灰字分隔，避免為了兩個小設定再開一張卡。
           給 flex:1 讓它在 card-head 裡撐開，右側的按鈕才會真的靠到最右。 */
        .ocoa-subhead {
          font-size: 12.5px; font-weight: 600; color: var(--ocoa-fg2);
          flex: 1 1 auto; min-width: 0;
          display: inline-flex; align-items: center; gap: var(--ocoa-s2);
        }
        .ocoa-divider { height: 1px; border: 0; background: var(--ocoa-line2); margin: 0; }
        /* 帳號列：四欄固定寬度，讓「名稱／到期／動作／移除」上下對齊。
           原本用 space-between，名稱長度不同時（OpenCode Desktop vs sa03）
           後面幾欄的起點就跟著跑掉。
           「到期」欄不能給太窄：宿主會顯示「剩餘 26d 15h」這種字串，108px 會
           折成兩行、把整列撐高，看起來像沒對齊。 */
        .ocoa-account-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 132px 92px 68px;
          align-items: center;
          gap: var(--ocoa-s3);
          min-width: 0;
        }
        /* 面板變窄時，固定四欄會把「切換／移除」擠出邊界。名稱先讓位，
           動作欄維持看得見——按鈕被裁掉比名稱被省略嚴重得多。 */
        @media (max-width: 720px) {
          .ocoa-account-row {
            grid-template-columns: minmax(0, 1fr) auto auto;
            gap: var(--ocoa-s2);
          }
          /* 窄版把到期時間收進名稱下方，四欄變三欄。 */
          .ocoa-account-row > .ocoa-badge { grid-column: 1; grid-row: 2; justify-self: start; }
          .ocoa-account-row > :nth-child(3) { grid-column: 2; }
          .ocoa-account-row > :nth-child(4) { grid-column: 3; }
        }
        /* Keep each control anchored to its grid track. The active marker uses
           the same switch track as the button, but is centered and never a button. */
        .ocoa-account-row > :nth-child(2) { justify-self: start; }
        .ocoa-account-row > :nth-child(3) { justify-self: center; }
        .ocoa-account-row > :nth-child(4) { justify-self: end; }
        .ocoa-account-name {
          display: flex; align-items: center; gap: var(--ocoa-s2); min-width: 0;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          font-size: 13px;
        }
        /* 圓點與名稱之間必須有間距。原本只有 flex 而沒有 gap，兩個 span 會黏成
           「●eva」——圓點看起來像字的一部分，而不是狀態指示。 */
        .ocoa-account-dot { flex: none; }
        /* 欄寬是固定的，內容就不該在格子裡折行去撐高整列。 */
        .ocoa-account-row .ocoa-badge,
        .ocoa-account-row .ocoa-chip,
        .ocoa-account-row .ocoa-btn { white-space: nowrap; }
        /* 「使用中」不是按鈕，就不該長得像按鈕。這一格講的是狀態，
           所以用一顆小圓點加綠字，而不是跟旁邊按鈕搶戲的亮色藥丸框。 */
        .ocoa-account-active {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 12.5px; font-weight: 560; color: var(--ocoa-ok);
        }
        .ocoa-account-active .ocoa-dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: currentColor; flex: none;
        }
        .ocoa-actions { display: flex; gap: 8px; flex-wrap: wrap; }

        /* 授權狀態的三個事實：橫向一排，窄視窗自動換行。
           不用外框包起來，只靠底色與內距分組——外面已經有卡片框了，
           再包一層就變成盒中盒。 */
        .ocoa-facts {
          display: flex; flex-wrap: wrap; gap: 0; margin: 0;
          border-radius: 10px;
          background: var(--ocoa-sunk);
          overflow: hidden;
        }
        .ocoa-fact {
          flex: 1 1 150px; min-width: 0;
          padding: 8px 12px;
          border-left: 1px solid var(--ocoa-line2);
        }
        .ocoa-fact:first-child { border-left: 0; }
        .ocoa-fact-label {
          font-size: 11.5px; color: var(--ocoa-fg3);
          margin: 0 0 var(--ocoa-s1); line-height: 1.4;
        }
        .ocoa-fact-value {
          margin: 0; font-size: 13px; color: var(--ocoa-fg);
          overflow-wrap: anywhere; line-height: 1.5;
        }

        /* 帳號清單：一條一條的列，列與列之間只有一條細線。 */
        .ocoa-account-list { display: flex; flex-direction: column; }
        .ocoa-account-list .ocoa-account-row + .ocoa-account-row {
          border-top: 1px solid var(--ocoa-line2);
        }
        .ocoa-account-row { padding: 6px 0; }
        .ocoa-account-dot {
          width: 7px; height: 7px; border-radius: 50%; flex: none;
          border: 1.5px solid var(--ocoa-line3); background: transparent;
        }
        .ocoa-account-dot.is-active { border-color: var(--ocoa-ok); background: var(--ocoa-ok); }
        .ocoa-account-label { overflow: hidden; text-overflow: ellipsis; }

        .ocoa-btn {
          font: inherit; font-size: 12.5px; font-weight: 500;
          padding: 6px 14px; border-radius: 8px; cursor: pointer;
          border: 1px solid var(--ocoa-line3);
          background: var(--ocoa-surface); color: var(--ocoa-fg);
          transition: background .15s ease, border-color .15s ease;
          white-space: nowrap;
          /* 按鈕裡的字多半是兩三個中文字，垂直置中比基線對齊穩。 */
          line-height: 20px;
        }
        .ocoa-btn:hover:not(:disabled) { background: var(--ocoa-hover); }
        .ocoa-btn:disabled { opacity: .45; cursor: default; }
        /* 主按鈕用同一個強調色，不再另外呼叫宿主的 button-primary-fill：
           那個變數在淺色主題下是紅色（state-error-primary），放在設定頁像警告。 */
        .ocoa-btn.primary {
          background: var(--ocoa-accent);
          color: var(--ocoa-on-accent);
          border-color: transparent;
          font-weight: 550;
        }
        .ocoa-btn.primary:hover:not(:disabled) {
          background: var(--ocoa-accent);
          filter: brightness(1.08);
        }
        .ocoa-btn.ghost { background: transparent; border-color: transparent; color: var(--ocoa-fg2); }
        .ocoa-btn.ghost:hover:not(:disabled) { background: var(--ocoa-hover); color: var(--ocoa-fg); }
        /* 卡片是 flex column，按鈕預設會被拉成整排寬——「顯示較少」於是一條
           橫貫整張卡的長條，看起來像分隔線而不是按鈕。 */
        .ocoa-card > .ocoa-btn { align-self: flex-start; }

        .ocoa-grid { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: var(--ocoa-s2) var(--ocoa-s3); font-size: 12.5px; }
        .ocoa-grid dd { margin: 0; color: var(--ocoa-fg); overflow-wrap: anywhere; }
        /* 診斷資訊收在 details 裡：展開後用緊一點的行距，避免一展開就吃掉半頁。 */
        .ocoa-grid-tight { gap: var(--ocoa-s1) var(--ocoa-s3); margin-top: var(--ocoa-s2); }
        .ocoa-details > summary {
          cursor: pointer; list-style: none;
          display: flex; align-items: center; gap: 6px;
        }
        .ocoa-details > summary::-webkit-details-marker { display: none; }
        /* 箭頭是額外佔位的字元，會把文字往右推、跟上面的次標題對不齊。
           用負邊距把整排拉回來，左緣就與卡片內緣切齊。 */
        .ocoa-details > summary::before {
          content: '▸'; font-size: 9px; color: var(--ocoa-fg3);
          flex: none; margin-left: -12px; width: 8px;
        }
        .ocoa-details[open] > summary::before { content: '▾'; }
        .ocoa-mono { font-family: var(--ocoa-mono); font-size: 12px; }

        /* 備援順位：三個並排，視窗太窄時自動換行。 */
        .ocoa-fallback-slots { display: flex; gap: var(--ocoa-s3); flex-wrap: wrap; }
        .ocoa-fallback-slot { display: flex; flex-direction: column; gap: var(--ocoa-s1); flex: 1 1 160px; min-width: 140px; }
        .ocoa-fallback-slot-label { font-size: 12px; color: var(--ocoa-fg3); }
        .ocoa-fallback-select { width: 100%; }

        /* 提示框：不用虛線框，改成左側一道細色條。
           底色刻意比 sunk 更淡：它是卡片裡的補充說明，不是另一個區塊。
           太重的灰底會讓整張卡看起來像切成兩塊。 */
        .ocoa-note {
          font-size: 12.5px; line-height: 1.65; color: var(--ocoa-fg2);
          background: color-mix(in srgb, var(--ocoa-sunk) 55%, transparent);
          border-radius: 0 8px 8px 0;
          border-left: 2px solid var(--ocoa-line3);
          padding: var(--ocoa-s2) var(--ocoa-s3);
        }
        .ocoa-codebox {
          display: flex; align-items: center; gap: var(--ocoa-s3); flex-wrap: wrap;
          background: var(--ocoa-sunk); border-radius: 10px;
          padding: var(--ocoa-s3) var(--ocoa-s4);
        }
        .ocoa-usercode {
          font-family: var(--ocoa-mono); font-size: 18px; font-weight: 650;
          letter-spacing: .16em;
        }
        .ocoa-url { font-family: var(--ocoa-mono); font-size: 12px; overflow-wrap: anywhere; color: var(--ocoa-fg2); }
        .ocoa-link { color: var(--ocoa-accent); text-decoration: none; }
        .ocoa-link:hover { text-decoration: underline; }

        .ocoa-toolbar { display: flex; align-items: center; gap: var(--ocoa-s3); flex-wrap: wrap; min-width: 0; }
        .ocoa-input {
          font: inherit; font-size: 12.5px; padding: 6px 12px; border-radius: 8px;
          border: 1px solid var(--ocoa-line3); background: var(--ocoa-surface); color: var(--ocoa-fg);
          min-width: 0; width: 240px; max-width: 100%;
          transition: border-color .13s ease;
        }
        .ocoa-input:focus-visible { outline: none; border-color: var(--ocoa-accent); }
        .ocoa-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--ocoa-fg2); }

        /* 表格是給人掃的，不是給人欣賞留白的。
           每一列必須同一高度：失敗原因若換行到狀態底下，那一列就變成兩倍高，
           眼睛會在「正常／失敗」之間不停重新對焦。原因改跟狀態同一行，
           放不下就省略，全文留在 title。 */
        .ocoa-table {
          width: 100%; border-collapse: collapse;
          font-size: 12px; table-layout: fixed;
        }
        .ocoa-table th {
          text-align: left; font-weight: 600; color: var(--ocoa-fg3);
          padding: 4px 6px;
          border-bottom: 1px solid var(--ocoa-line2);
          font-size: 11px; letter-spacing: .02em;
        }
        .ocoa-table td {
          padding: 3px 6px;
          border-bottom: 1px solid var(--ocoa-line);
          vertical-align: middle;
        }
        /* 嚴格鎖定單行行高，維持高密度閱讀，不換行折行 */
        .ocoa-model-row td { height: 26px; }
        .ocoa-table tr:last-child td { border-bottom: none; }
        .ocoa-table tbody tr:hover { background: var(--ocoa-hover); }
        .ocoa-table th:nth-child(1), .ocoa-table td:nth-child(1) { width: 30px; }
        .ocoa-table th:nth-child(3), .ocoa-table td:nth-child(3) { width: 140px; }
        .ocoa-table th:nth-child(4), .ocoa-table td:nth-child(4) { width: 68px; text-align: right; }
        .ocoa-table th:nth-child(5), .ocoa-table td:nth-child(5) { width: 58px; text-align: right; }
        .ocoa-context-btn {
          font: inherit; font-size: 11.5px; font-variant-numeric: tabular-nums;
          background: transparent; border: 1px solid transparent; border-radius: 4px;
          padding: 1px 5px; cursor: pointer; color: var(--ocoa-fg);
          display: inline-flex; align-items: center; gap: 3px; justify-content: flex-end;
          transition: background .12s, border-color .12s;
        }
        .ocoa-context-btn:hover {
          background: var(--ocoa-hover); border-color: var(--ocoa-line2); color: var(--ocoa-accent);
        }
        .ocoa-context-btn.is-custom {
          color: var(--ocoa-accent); font-weight: 550;
        }
        .ocoa-modal-backdrop {
          position: fixed; top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(2px);
          display: flex; align-items: center; justify-content: center;
          z-index: 1000; padding: var(--ocoa-s4);
        }
        .ocoa-modal-dialog {
          background: var(--ocoa-surface); border: 1px solid var(--ocoa-line3);
          border-radius: 12px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.2);
          width: 100%; max-width: 440px; display: flex; flex-direction: column;
          gap: var(--ocoa-s3); padding: var(--ocoa-s4); color: var(--ocoa-fg);
        }
        .ocoa-modal-header {
          display: flex; align-items: flex-start; justify-content: space-between; gap: var(--ocoa-s2);
        }
        .ocoa-modal-title { font-size: 15px; font-weight: 600; line-height: 1.3; margin: 0; color: var(--ocoa-fg); }
        .ocoa-modal-sub { font-size: 12px; color: var(--ocoa-fg3); margin-top: 2px; font-family: var(--ocoa-mono); word-break: break-all; }
        .ocoa-modal-close {
          background: transparent; border: none; cursor: pointer;
          color: var(--ocoa-fg3); font-size: 16px; line-height: 1; padding: 4px; border-radius: 6px;
        }
        .ocoa-modal-close:hover { background: var(--ocoa-hover); color: var(--ocoa-fg); }
        .ocoa-modal-body { display: flex; flex-direction: column; gap: var(--ocoa-s3); }
        .ocoa-modal-info {
          font-size: 12px; line-height: 1.5; color: var(--ocoa-fg2);
          background: var(--ocoa-sunk); border-radius: 8px; padding: 10px 12px;
        }
        .ocoa-modal-footer {
          display: flex; align-items: center; justify-content: space-between;
          gap: var(--ocoa-s2); margin-top: var(--ocoa-s2); padding-top: var(--ocoa-s2);
          border-top: 1px solid var(--ocoa-line2);
        }
        /* 勾選框：用 accent-color 直接吃掉宿主主題 */
        .ocoa-pick { padding-right: 0 !important; padding-left: 4px !important; }
        .ocoa-pick-box {
          appearance: auto; width: 14px; height: 14px; margin: 0;
          accent-color: var(--ocoa-accent); cursor: pointer;
          vertical-align: middle;
        }
        .ocoa-pick-box:disabled { cursor: not-allowed; opacity: .35; }
        .ocoa-pick-box:focus-visible { outline: 2px solid var(--ocoa-accent); outline-offset: 2px; }
        .ocoa-picker-mode {
          display: flex; align-items: baseline; gap: var(--ocoa-s2);
          font-size: 12px; color: var(--ocoa-fg3);
        }
        .ocoa-picker-mode-text { min-width: 0; }
        .ocoa-picker-mode .ocoa-badge { flex: none; }
        .ocoa-status {
          display: flex; flex-direction: row; align-items: center;
          gap: 6px; min-width: 0; white-space: nowrap; overflow: hidden;
        }
        .ocoa-status-reason {
          font-size: 11px; line-height: 1.2; color: var(--ocoa-fg3);
          min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .ocoa-status .ocoa-badge { flex: none; }
        .ocoa-model { font-family: var(--ocoa-mono); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ocoa-model-id {
          display: block; font-family: var(--ocoa-mono); font-size: 12px; line-height: 1.3;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .ocoa-model-row.is-open { background: var(--ocoa-sunk); }
        /* 展開列從「模型」欄的起點開始，不要在勾選欄下方也鋪一條灰底：
           灰底跨過勾選欄會讓那一欄看起來像被合併掉了。 */
        .ocoa-model-expand td { padding: 0 8px var(--ocoa-s3) 34px; border-bottom: 1px solid var(--ocoa-line2); }
        .ocoa-expand-body {
          display: grid; gap: var(--ocoa-s2);
          padding: var(--ocoa-s3); border-radius: 9px;
          background: var(--ocoa-sunk2);
        }
        .ocoa-expand-reason { font-size: 12.5px; font-weight: 600; color: var(--ocoa-off); }
        .ocoa-num { font-variant-numeric: tabular-nums; color: var(--ocoa-fg2); }
        .ocoa-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; }
        .ocoa-badge.ok { color: var(--ocoa-ok); }
        .ocoa-badge.off { color: var(--ocoa-off); }
        .ocoa-badge.dim { color: var(--ocoa-fg3); font-weight: 400; }
        /* 限流不是失敗：模型有效，只是額度或速率暫時排不進去。 */
        .ocoa-badge.warn { color: var(--ocoa-warn); }
        /* 強調色的徽章只給「這是你設定的模式」用，不是錯誤也不是警告。 */
        .ocoa-badge.accent { color: var(--ocoa-accent); }
        .ocoa-diagnostic-meta { margin-top: var(--ocoa-s1); color: var(--ocoa-fg3); font-size: 11.5px; line-height: 1.5; }
        .ocoa-context-editor { margin-top: var(--ocoa-s2); color: var(--ocoa-fg2); }
        .ocoa-context-editor summary { cursor: pointer; color: var(--ocoa-accent); font-size: 12px; }
        .ocoa-context-panel {
          display: grid; gap: var(--ocoa-s2); margin-top: var(--ocoa-s2); padding: var(--ocoa-s3);
          border: 1px solid var(--ocoa-line2); border-radius: 9px; background: var(--ocoa-surface);
        }
        .ocoa-context-default, .ocoa-context-hint { margin: 0; font-size: 12px; line-height: 1.6; }
        .ocoa-context-hint { color: var(--ocoa-fg3); }
        .ocoa-context-field { display: grid; gap: var(--ocoa-s1); font-size: 12px; color: var(--ocoa-fg2); }
        .ocoa-context-number { width: min(100%, 260px); }

        /* 上游原始回應。刻意用等寬字、縮小一級：這是要拿來複製或搜尋的
           原始資料，不是給人閱讀的句子。太長時省略，hover 顯示全文。 */
        .ocoa-raw {
          margin-top: 3px;
          font-size: 11px;
          line-height: 1.45;
          color: var(--ocoa-fg3);
          opacity: 0.85;
        }
        .ocoa-raw-label {
          font-weight: 600;
          margin-right: 2px;
        }
        .ocoa-raw code {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 10.5px;
          background: rgba(127, 127, 127, 0.10);
          border-radius: 3px;
          padding: 0 3px;
          word-break: break-all;
          /* 最多兩行就截斷，避免某個模型回了整頁 HTML 把表格撐爛。 */
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        .ocoa-spin { display: inline-block; animation: ocoa-spin 1s linear infinite; }
        @keyframes ocoa-spin { to { transform: rotate(360deg); } }
        .ocoa-loading { color: var(--ocoa-fg3); font-size: 12.5px; padding: 18px 0; }
        @media (prefers-reduced-motion: reduce) {
          .ocoa-spin { animation: none; }
          .ocoa-btn { transition: none; }
        }

        /* 語言切換鍵：標題列最右側。顏色一律走主題變數，淺色／深色都會跟著換。 */
        .ocoa-lang {
          margin-left: auto;              /* 推到標題列最右邊 */
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: var(--dsw-alias-label-tertiary);
        }
        .ocoa-lang-label { white-space: nowrap; }
        .ocoa-lang-select {
          appearance: auto;
          font: inherit;
          font-size: 12px;
          color: var(--dsw-alias-label-primary);
          background: var(--dsw-alias-bg-layer-2);
          border: 1px solid var(--dsw-alias-border-l1);
          border-radius: 6px;
          padding: 3px 6px;
          cursor: pointer;
          max-width: 220px;
        }
        .ocoa-lang-select:hover { background: var(--ocoa-hover); }
        .ocoa-lang-select:focus-visible {
          outline: 2px solid var(--ocoa-accent);
          outline-offset: 1px;
        }
        .ocoa-go-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-top: 8px;
        }
        .ocoa-go-row {
          padding: 8px 10px;
          border-radius: 7px;
          border: 1px solid var(--ocoa-border);
          background: var(--ocoa-bg-sub);
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .ocoa-go-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          flex-wrap: wrap;
        }
        .ocoa-go-id {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 11.5px;
          color: var(--ocoa-fg2);
        }
        .ocoa-go-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          font-size: 11px;
          color: var(--ocoa-fg3);
        }
        .ocoa-go-pill {
          padding: 1px 6px;
          border-radius: 4px;
          border: 1px solid var(--ocoa-border);
          background: var(--dsw-alias-bg-layer-2);
          color: var(--ocoa-fg2);
        }
        .ocoa-go-cred-box {
          display: grid;
          gap: 8px;
          margin-top: 8px;
          padding: 10px 12px;
          border-radius: 8px;
          border: 1px solid var(--ocoa-line2);
          background: var(--ocoa-sunk);
        }
        .ocoa-go-cred-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          flex-wrap: wrap;
          padding-top: 8px;
          border-top: 1px solid var(--ocoa-line2);
        }
        .ocoa-go-cred-notes {
          display: grid;
          gap: 3px;
          font-size: 11px;
          line-height: 1.45;
          color: var(--ocoa-fg2);
        }
        .ocoa-go-cred-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          flex-wrap: wrap;
          font-size: 12px;
          color: var(--ocoa-fg2);
        }
        .ocoa-go-cred-head .ocoa-chip {
          flex: none;
          white-space: nowrap;
        }
        .ocoa-go-cred-row {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
        }
        .ocoa-go-cred-input {
          flex: 1 1 220px;
          min-width: 180px;
        }
        .ocoa-go-cred-collapsed {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          flex-wrap: wrap;
        }
        .ocoa-go-usage-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
          margin-top: 8px;
        }
        .ocoa-go-usage-card {
          padding: 8px 10px;
          border-radius: 6px;
          border: 1px solid var(--ocoa-line2);
          background: var(--ocoa-surface);
          display: grid;
          gap: 5px;
          min-width: 0;
        }
        .ocoa-go-usage-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 6px;
          font-size: 11px;
          color: var(--ocoa-fg2);
        }
        .ocoa-go-usage-pct {
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .ocoa-go-usage-pct.is-ok { color: var(--ocoa-ok); }
        .ocoa-go-usage-pct.is-warn { color: var(--ocoa-warn); }
        .ocoa-go-usage-pct.is-bad { color: var(--ocoa-off); }
        .ocoa-go-usage-bar {
          height: 5px;
          border-radius: 999px;
          background: var(--ocoa-sunk);
          overflow: hidden;
        }
        .ocoa-go-usage-fill {
          height: 100%;
          border-radius: 999px;
        }
        .ocoa-go-usage-fill.is-ok { background: var(--ocoa-ok); }
        .ocoa-go-usage-fill.is-warn { background: var(--ocoa-warn); }
        .ocoa-go-usage-fill.is-bad { background: var(--ocoa-off); }
        .ocoa-go-usage-reset {
          font-size: 10px;
          color: var(--ocoa-fg3);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ocoa-go-catalog {
          display: flex;
          flex-direction: column;
          gap: 10px;
          margin-top: 10px;
          min-width: 0;
        }
        .ocoa-go-table-scroll {
          width: 100%;
          max-width: 100%;
          overflow-x: auto;
        }
        .ocoa-go-table {
          width: 100%;
        }
        .ocoa-go-table th:nth-child(1), .ocoa-go-table td:nth-child(1) { width: 42px; text-align: center; }
        .ocoa-go-table th:nth-child(2), .ocoa-go-table td:nth-child(2) { width: auto; min-width: 0; }
        .ocoa-go-table th:nth-child(3), .ocoa-go-table td:nth-child(3) { width: 78px; text-align: right; }
        .ocoa-go-table th:nth-child(4), .ocoa-go-table td:nth-child(4) { width: 78px; text-align: right; }
        .ocoa-go-table .ocoa-model-expand td {
          padding: 0 8px var(--ocoa-s3) 8px;
          text-align: left;
          width: auto;
        }
        .ocoa-go-table .ocoa-go-model-btn .ocoa-model-id,
        .ocoa-go-table .ocoa-go-model-btn .ocoa-model-toggle {
          flex: 1 1 auto;
          min-width: 0;
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ocoa-go-model-btn {
          appearance: none;
          background: transparent;
          border: 0;
          padding: 0;
          margin: 0;
          width: 100%;
          text-align: left;
          font: inherit;
          color: inherit;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }
        .ocoa-go-model-btn:hover { color: var(--ocoa-accent); }
        .ocoa-go-model-btn:focus-visible { outline: 2px solid var(--ocoa-accent); outline-offset: 2px; border-radius: 4px; }
        .ocoa-go-caret {
          flex: none;
          font-size: 10px;
          color: var(--ocoa-fg3);
          width: 10px;
        }
        .ocoa-go-caps-cell {
          font-size: 11.5px;
          color: var(--ocoa-fg2);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      `;
      document.head.appendChild(style);
    }

    /* --------------------------------------------------------------- 元件 */

    const MODELS_COLLAPSED = 8;

    function Chip({ tone, text }) {
      return h(
        'span',
        { className: `ocoa-chip ${tone}` },
        h('span', { className: 'ocoa-chip-dot' }),
        text
      );
    }

    function Row({ label, children }) {
      return [h('dt', { key: `${label}-k` }, label), h('dd', { key: `${label}-v` }, children)];
    }

    /**
     * 橫向事實條的一格：上面是小字標籤，下面是值。
     *
     * 為什麼不繼續用 `Row`（dt/dd 直排）：憑證來源、到期、可否自動續這三項
     * 是一組短值，直排會把一張卡撐成兩倍高卻沒有更好讀。橫排讓它們在同一條
     * 視線上，掃一眼就看完。
     */
    function Fact({ label, children }) {
      return h(
        'div',
        { className: 'ocoa-fact', key: `${label}-fact` },
        h('dt', { className: 'ocoa-fact-label' }, label),
        h('dd', { className: 'ocoa-fact-value' }, children)
      );
    }

    /**
     * 語言切換鍵。
     *
     * 只改本分頁的語言，不會呼叫宿主的 `setLocale()`——那會把選擇寫進 DSH 的
     * 使用者設定，連帶換掉整個介面的語言。這裡的選擇存在外掛自己的鍵上。
     *
     * 選 `auto`（跟隨系統）時，標題會顯示實際解析出來的語言，讓使用者看得出
     * 「跟隨系統」目前代表什麼，而不是只有一個抽象的選項名稱。
     */
    function LanguageSwitcher({ choice, localeId, t, onChange }) {
      const autoLabel =
        choice === 'auto' ? `${t('languageAuto')} · ${t(`languageOf_${localeId}`)}` : t('languageAuto');

      return h(
        'label',
        { className: 'ocoa-lang' },
        // 視覺上只留 select，但 label 對讀屏與點擊範圍都有用。
        h('span', { className: 'ocoa-lang-label' }, t('languageLabel')),
        h(
          'select',
          {
            className: 'ocoa-lang-select',
            value: choice,
            onChange: (event) => onChange(event.target.value),
            'aria-label': t('languageLabel')
          },
          ...LANGUAGE_OPTIONS.map((option) =>
            h(
              'option',
              { key: option.id, value: option.id },
              option.id === 'auto' ? autoLabel : t(option.label)
            )
          )
        )
      );
    }

    function loginFailureText(t, failure) {
      if (!failure || typeof failure.code !== 'string') return '';
      if (failure.code === 'timeout') return t('loginFailedTimeout');
      if (failure.code === 'denied') return t('loginFailedDenied');
      if (failure.code === 'expired') return t('loginFailedExpired');
      if (failure.code === 'network') return t('loginFailedNetwork');
      const detail = typeof failure.message === 'string' && failure.message ? failure.message : failure.code;
      return t('loginFailed', { message: detail });
    }

    function SettingsPage({ ctx, t: hostT }) {
      /* ------------------------------------------------------ 語言狀態

         這一頁的語言完全由自己決定（跟隨系統／英文／簡中／繁中），刻意不採用
         宿主的 `t`：那個 translator 綁在 DSH 全域語言上，用它就表示切換語言會
         連帶影響整個 DSH。`hostT` 只保留給「本頁還沒有系統語言資訊時」的
         暫時過渡，一旦拿到 status 就完全改用本地解析結果。 */

      // 使用者的明確選擇：'auto' 或某個語言 id。null 代表從未選過。
      const [languageChoice, setLanguageChoice] = React.useState(() => readStoredLanguage());

      const [status, setStatus] = React.useState(null);

      // 主機端讀到的系統語言。拿到 status 之後才有值。
      const systemLocale = status?.systemLocale ?? null;

      const localeId = React.useMemo(
        () => resolveLocale(languageChoice, systemLocale),
        [languageChoice, systemLocale]
      );

      const t = React.useMemo(() => translator(localeId), [localeId]);
      const [busy, setBusy] = React.useState('');
      const [message, setMessage] = React.useState(null);
      const [copied, setCopied] = React.useState('');
      // 表格預設整份展開。
      //
      // 原本預設收成 8 列，理由是「46 列一進來就全開很嚇人」。實際用起來剛好
      // 相反：使用者的目的就是掃一遍有哪些能用、要把哪幾個勾起來，收合只是
      // 逼他先按一次「顯示其餘 38 個」。勾選還需要跨列比較，看不到全部就沒法比。
      const [showAll, setShowAll] = React.useState(true);
      // 預設停在「模型」：那是最常進來看的東西。
      const [tabState, setTabState] = React.useState('models');
      // 優先讀取上次使用者記下的分類篩選；未儲存過時為 null，
      // 後續依「有沒有探測結果」自動決定：有結果看可用的，沒結果看全部。
      const [modelFilter, setModelFilter] = React.useState(() => readStoredFilter());
      // 一次只展開一列：展開的內容是探測細節與上下文設定，同一時間看兩份只會
      // 讓表格變成兩倍長，而使用者通常只是在找某一列壞在哪。
      const [expandedModel, setExpandedModel] = React.useState(null);
      const [filter, setFilter] = React.useState('');
      const [loaded, setLoaded] = React.useState(false);

      // 備援設定：主機端是真相，這裡只是它的草稿。
      //
      // `fallbackDraft` 是 null 代表「還沒動過」，畫面直接顯示主機端的值；
      // 使用者一動（勾選或改順位）才變成草稿，等按下儲存才送回主機。
      // 不這樣做的話，畫面上的值會跟著每 15 秒一次的輪詢被覆蓋掉。
      const [fallbackDraft, setFallbackDraft] = React.useState(null);

      // 不使用 window.prompt：DSH 的嵌入式設定頁可能不顯示原生對話框，按鈕看起來
      // 就會像沒有反應。改成頁面內的輸入列，讓 label 可填可留白，且可明確取消。
      const [addAccountOpen, setAddAccountOpen] = React.useState(false);
      const [accountLabel, setAccountLabel] = React.useState('');
      const [contextDrafts, setContextDrafts] = React.useState({});
      const [contextModalModel, setContextModalModel] = React.useState(null);
      const [removeAccountModal, setRemoveAccountModal] = React.useState(null);
      const [contextInputVal, setContextInputVal] = React.useState('');
      const [goKeyInput, setGoKeyInput] = React.useState('');
      const [goKeyEditing, setGoKeyEditing] = React.useState(false);
      const [goFilter, setGoFilter] = React.useState('all');
      const [goSearch, setGoSearch] = React.useState('');
      const [goShowAll, setGoShowAll] = React.useState(false);
      const [goExpandedModel, setGoExpandedModel] = React.useState(null);

      const numberLabel = (value) => Number.isFinite(Number(value))
        ? Number(value).toLocaleString(localeId)
        : '–';

      const openContextModal = (model) => {
        setContextModalModel(model);
        const current = model.contextOverride ?? model.catalogContextWindow ?? model.contextWindow ?? 200000;
        setContextInputVal(String(current));
      };
      const closeContextModal = () => {
        setContextModalModel(null);
      };

      // translator 放進 ref。宿主透過 inject() 給的 t 不保證身分穩定（可能每次
      // 渲染都重建一次），若直接當成 useCallback 的相依，load 就會跟著每次渲染
      // 換新，下面那個輪詢 effect 也就在每次渲染重跑一次——變成沒完沒了的請求風暴。
      const tRef = React.useRef(t);
      tRef.current = t;

      const load = React.useCallback(async () => {
        try {
          setStatus(await callApi('status'));
          setLoaded(true);
        } catch (error) {
          setLoaded(true);
          setMessage({ kind: 'error', text: tRef.current('errorGeneric', { message: error.message }) });
        }
      }, []);

      const pending = status?.pendingLogin ?? null;

      // 有待核准的登入時加快輪詢，讓頁面自己反映出結果，不必使用者按任何東西。
      // 相依只有 pending，所以平常不會反覆重掛。
      React.useEffect(() => {
        let alive = true;
        const tick = () => {
          if (alive) load();
        };
        tick();
        const timer = window.setInterval(tick, pending ? 2000 : 15000);
        return () => {
          alive = false;
          window.clearInterval(timer);
        };
      }, [load, pending]);

      // 「已複製」的提示會自己消失；計時器隨頁面結束而亡。
      React.useEffect(() => {
        if (!copied) return undefined;
        const timer = window.setTimeout(() => setCopied(''), 1400);
        return () => window.clearTimeout(timer);
      }, [copied]);

      const copy = (text, id) => {
        const write = navigator.clipboard?.writeText?.(String(text));
        Promise.resolve(write).then(
          () => setCopied(id),
          () => {}
        );
      };

      const act = async (name, pathname, payload) => {
        setBusy(name);
        setMessage(null);
        try {
          const value = await callApi(pathname, 'POST', payload);
          // 登入在等待期間被登出取消：伺服器不會回傳可開啟的驗證網址（見
          // web-api.js）。這裡明確說明「已取消」，否則畫面會停在忙碌狀態。
          if ((pathname === 'login' || pathname === 'accounts') && value?.cancelled) {
            setMessage({ kind: 'info', text: t('loginCancelled') });
            await load();
            return;
          }
          if (pathname === 'login/cancel') {
            setMessage({ kind: 'info', text: t('loginCancelled') });
            await load();
            return;
          }
          if ((pathname === 'login' || pathname === 'accounts') && value?.verificationUrl) {
            setMessage({ kind: 'info', text: t('waiting') });
            window.open(value.verificationUrl, '_blank', 'noopener');
          }
          if (pathname === 'logout') {
            setMessage({ kind: 'info', text: value?.note ?? '' });
          }
          if (pathname === 'accounts/import-local') {
            setMessage({
              kind: 'info',
              text: value?.alreadyPresent ? t('importLocalAlready') : t('importLocalDone')
            });
          }
          if (pathname === 'go/credential') {
            setMessage({ kind: 'info', text: t('goKeySavedMsg') });
          }
          if (pathname === 'go/credential/clear') {
            setMessage({ kind: 'info', text: t('goKeyClearedMsg') });
          }
          await load();
        } catch (error) {
          setMessage({ kind: 'error', text: t('errorGeneric', { message: error.message }) });
        } finally {
          setBusy('');
        }
      };

      const beginAddAccount = () => {
        const label = accountLabel.trim();
        setAddAccountOpen(false);
        setAccountLabel('');
        void act('login', 'accounts', { label });
      };

      const cancelAddAccount = () => {
        setAddAccountOpen(false);
        setAccountLabel('');
      };

      if (!status) {
        // 載入中的畫面也要有語言切換鍵。
        //
        // 這不只是為了測試好看：使用者第一次開啟這個分頁時，status 還沒回來
        // （或是讀取失敗），若整個畫面只有一行「正在整理…」，他會找不到切換鍵，
        // 也就沒辦法在使用者想要語言的那一刻換語言——而那正是他最需要它的時候。
        return h(
          'div',
          { className: 'ocoa-page' },
          h(
            'div',
            { className: 'ocoa-head' },
            h(
              'div',
              { className: 'ocoa-title-row' },
              h('span', { className: 'ocoa-title' }, t('title')),
              h(LanguageSwitcher, {
                choice: languageChoice ?? 'auto',
                localeId,
                t,
                onChange: (value) => {
                  setLanguageChoice(value);
                  writeStoredLanguage(value);
                }
              })
            )
          ),
          h(
            'p',
            { className: 'ocoa-loading' },
            loaded ? t('loadFailed') : t('refreshing')
          )
        );
      }

      const accounts = status.accounts ?? [];
      const chip = healthChip(status.health);
      const cred = status.credential ?? {};
      const models = status.models?.models ?? [];
      const summary = status.models ?? {};
      // 勾選功能現狀。舊版主機（或沒接 store 的情境）不會有這個欄位，
      // 那就整欄不畫，而不是畫一個永遠 disabled 的勾選欄。
      const picker = status.picker ?? null;
      const cfg = status.config ?? {};

      const sourceLabel =
        // `accounts` 是多帳號模式下的憑證來源（token-manager 從帳號清單取用）。
        // 少了這一個分支，切換過帳號之後這一格就會顯示「未知來源」——明明
        // 憑證是有效的，卻讓使用者以為來源不明。
        cred.source === 'accounts'
          ? t('srcAccounts')
          : cred.source === 'local-db'
            ? t('srcLocalDb')
            : cred.source === 'dsh-token-file'
              ? t('srcTokenFile')
              : cred.source === 'local-auth-json'
                ? t('srcAuthJson')
                : t('srcUnknown');

      // 到期時間：優先顯示「還剩多久」，因為那才是使用者真正想知道的事；
      // 絕對時間放在括號裡補充。
      // 時間單位跟著介面語言走：中文頁不該出現「26d 15h」。
      const durUnits = {
        d: t('unitDay'),
        h: t('unitHour'),
        m: t('unitMinute'),
        lessThanMinute: t('unitLessThanMinute')
      };
      const dur = (ms) => shortDuration(ms, durUnits);

      let expiryText;
      if (!cred.present) expiryText = '–';
      else if (cred.expired) expiryText = t('expiresPast');
      else if (cred.expiresInSeconds === null || cred.expiresInSeconds === undefined) {
        expiryText = t('expiresNoExpiry');
      } else {
        const when = formatWhen(cred.expiresAt * 1000, localeId);
        expiryText = when
          ? `${t('expiresIn', { time: dur(cred.expiresInSeconds * 1000) })}（${t('expiresAt', { when })}）`
          : t('expiresIn', { time: dur(cred.expiresInSeconds * 1000) });
      }

      const probedWhen = summary.probedAt ? formatWhen(summary.probedAt, localeId) : null;

      const intervalLabel = (ms) => {
        if (!ms || !Number.isFinite(ms)) return '–';
        const hours = ms / 3600000;
        if (hours >= 1) return t('intervalHours', { h: Math.round(hours * 10) / 10 });
        return t('intervalMinutes', { m: Math.round(ms / 60000) });
      };

      const byteLabel = (n) =>
        typeof n === 'number' && Number.isFinite(n) ? `${n.toLocaleString()} B` : '–';

      // 使用者還沒選過分類時顯示全部。
      //
      // 刻意不預設「可用」：`available` 只在探測過之後才有意義，憑證剛接好、
      // 還沒探測時每一筆都是 undefined，預設可用會讓整張表變成空的——那看起來
      // 像外掛壞了，而不是「還沒探測」。
      //
      // 但「記住上次的篩選」會把同一個陷阱變成常態：上次停在「可用」，這次
      // 開機沒有任何探測資料，於是 46 個候選、0 筆可用、整張表空白。使用者
      // 看到的是「我的探測紀錄不見了」，實際上只是被一個空集合篩掉。
      // 所以還原篩選時要驗證它現在有意義：沒有任何一列可用就退回「全部」，
      // 讓畫面至少說得出「尚未探測」而不是一片空白。
      const probedRows = models.filter((m) => m.probed === true);
      const usableRows = probedRows.filter((m) => (m.valid ?? m.available) === true);
      const storedFilter = modelFilter;
      const filterHasNoRows =
        storedFilter !== null &&
        storedFilter !== 'all' &&
        (storedFilter === 'available'
          ? usableRows.length === 0
          : models.some((m) => m.probed === true) &&
            models.filter((m) => m.reason === storedFilter).length === 0);
      const activeFilter = filterHasNoRows ? 'all' : (storedFilter ?? 'all');

      const query = filter.trim().toLowerCase();
      const matched = models.filter((m) => {
        // 「可用」＝上游認得這個模型。429 只代表這次排不進去，模型本身有效，
        // 所以算在可用裡。
        if (activeFilter === 'available' && (m.valid ?? m.available) !== true) return false;
        if (activeFilter !== 'all' && activeFilter !== 'available' && m.reason !== activeFilter) return false;
        if (query && !m.id.toLowerCase().includes(query)) return false;
        return true;
      });

      // 排序：勾選的排在最上面。
      //
      // 理由很直接：勾選是使用者明確表示「我要這個」，那一份就是他實際在
      // 選擇器裡看到的清單。放在最上面，他掃一眼就能確認「現在有哪些能用」，
      // 不用在一張 46 列的表裡用眼睛過濾打勾的少數幾列。
      //
      // 排序必須是穩定的：同一個勾選狀態內保持目錄原序，否則每次輪詢
      // 更新資料時列會亂跳，使用者剛看的那一列會跑掉。
      const filtered = [...matched].sort((a, b) => {
        const sa = a.shown === true ? 0 : 1;
        const sb = b.shown === true ? 0 : 1;
        return sa - sb;
      });
      const visible = showAll ? filtered : filtered.slice(0, MODELS_COLLAPSED);

      // 展開中的那一列可能被切在收合邊界之外。
      //
      // 使用者的動作是「點開某一列看詳情」，如果那一列剛好落在第 9 列之後，
      // 收合狀態下它就消失，畫面上只剩一片空白——他會以為「卡片卡住了」。
      // 這種情況就地展開整份，比默默吃掉他的點擊合理。
      //
      // 用純計算而不是呼叫 setShowAll：在渲染期間改 state 會讓 React 反覆
      // 重跑這個元件（而且是無聲的），畫面會抖。
      const expandedOutsideWindow = !showAll
        && expandedModel !== null
        && filtered.some((m) => m.id === expandedModel)
        && !visible.some((m) => m.id === expandedModel);
      const rows = expandedOutsideWindow ? filtered : visible;

      /* ---------------------------------------------------- 備援設定 */

      // 主機端的值（每次輪詢更新）與使用者正在改的草稿。
      const fallbackSaved = status.fallback ?? { enabled: false, models: [], maxModels: 3 };
      const fallbackState = fallbackDraft ?? fallbackSaved;
      const fallbackDirty = fallbackDraft !== null;

      // 可選的模型：只列探測為可用的。把已經確定不通的模型放進下拉選單，
      // 等於邀請使用者把備援指向一個不會成功的目標。
      const selectable = models.filter((m) => m.ok);

      const slotValue = (index) => fallbackState.models?.[index] ?? '';

      const setSlot = (index, value) => {
        const next = [...(fallbackState.models ?? [])];
        // 清空選項時要真的清掉那個位置，不能留下 undefined——
        // JSON 化之後它會變成 null，伺服端就得額外處理這個型別。
        if (value === '' || value === undefined) next.splice(index, 1);
        else next[index] = value;
        // 去重時保留先出現的那一個：使用者在第一順位選了 A，
        // 第三順位就不該還留著 A。
        const deduped = next.filter((id, i) => id && next.indexOf(id) === i);
        setFallbackDraft({
          enabled: fallbackState.enabled,
          models: deduped,
          maxModels: fallbackSaved.maxModels ?? 3
        });
      };

      const toggleFallback = (enabled) => {
        setFallbackDraft({
          enabled,
          models: [...(fallbackState.models ?? [])],
          maxModels: fallbackSaved.maxModels ?? 3
        });
      };

      const toggleAutoSwitch = async (enabled) => {
        setBusy('auto-switch');
        setMessage(null);
        try {
          await callApi('auto-switch', 'POST', { enabled });
          setMessage({ kind: 'info', text: t('autoSwitchSaved') });
          await load();
        } catch (error) {
          setMessage({ kind: 'error', text: t('errorGeneric', { message: error.message }) });
        } finally {
          setBusy('');
        }
      };

      const saveFallback = async () => {
        setBusy('fallback');
        setMessage(null);
        try {
          const value = await callApi('fallback', 'POST', {
            enabled: fallbackState.enabled,
            models: fallbackState.models ?? []
          });
          // 主機端可能修剪過（未知模型、重複、超過三個），所以存完以它為準。
          setFallbackDraft(null);
          setMessage({ kind: 'info', text: t('fallbackSaved') });
          await load();
          return value;
        } catch (error) {
          setMessage({ kind: 'error', text: t('errorGeneric', { message: error.message }) });
          return null;
        } finally {
          setBusy('');
        }
      };

      // 勾選／取消：一次只改一個模型。
      //
      // 走 busy 集中管理（而不是每列各自的 loading）：勾選是「表格層級」的
      // 狀態改變，同一時間只該有一筆在飛，否則快速連點會讓後到的回應覆蓋
      // 先到的結果。
      const togglePicker = async (modelId, shown) => {
        setBusy(`picker:${modelId}`);
        setMessage(null);
        try {
          await callApi('picker', 'POST', { modelId, shown });
          await load();
        } catch (error) {
          setMessage({ kind: 'error', text: t('errorGeneric', { message: error.message }) });
        } finally {
          setBusy('');
        }
      };

      // 勾選欄能不能動。
      //
      // 判準是「上游有沒有認得這個模型」（valid），不是「這次問不問得到」（ok）。
      // 429 只是額度或速率受限，模型本身有效，使用者當然有權決定要不要把它
      // 留在選擇器裡；真正該禁用的只有上游已判定不存在／下架的模型。
      const pickerEnabled = (m) => (m.valid ?? m.available) === true && busy === '';

      // 回到自動模式：等於「我不要再挑了」，全部可用模型重新顯示。
      const resetPicker = async () => {
        setBusy('picker-reset');
        setMessage(null);
        try {
          await callApi('picker', 'POST', { mode: 'auto' });
          await load();
        } catch (error) {
          setMessage({ kind: 'error', text: t('errorGeneric', { message: error.message }) });
        } finally {
          setBusy('');
        }
      };

      const contextDraftFor = (model) => contextDrafts[model.id] ?? {
        mode: model.contextOverride == null ? 'default' : 'custom',
        value: String(model.contextOverride ?? model.contextWindow ?? '')
      };

      const updateContextDraft = (model, patch) => {
        const current = contextDraftFor(model);
        setContextDrafts({ ...contextDrafts, [model.id]: { ...current, ...patch } });
      };

      const contextDraftChanged = (model, draft) => draft.mode === 'default'
        ? model.contextOverride != null
        : model.contextOverride == null || Number(draft.value) !== model.contextOverride;

      const persistContext = async (model, contextWindow) => {
        setBusy('context');
        setMessage(null);
        try {
          await callApi('context', 'POST', { modelId: model.id, contextWindow });
          const nextDrafts = { ...contextDrafts };
          delete nextDrafts[model.id];
          setContextDrafts(nextDrafts);
          setMessage({ kind: 'info', text: t('contextSaved') });
          await load();
        } catch (error) {
          setMessage({ kind: 'error', text: t('errorGeneric', { message: error.message }) });
        } finally {
          setBusy('');
        }
      };

      const saveContext = async (model) => {
        const draft = contextDraftFor(model);
        if (draft.mode === 'default') return persistContext(model, null);
        const value = Number(draft.value);
        if (!Number.isSafeInteger(value) || value < 1024 || value > 100000000) {
          setMessage({ kind: 'error', text: t('contextInvalid') });
          return;
        }
        return persistContext(model, value);
      };

      const resetContext = (model) => persistContext(model, null);

      const fallbackSlots = [];
      for (let i = 0; i < (fallbackSaved.maxModels ?? 3); i++) {
        const current = slotValue(i);
        const options = [h('option', { key: '__none', value: '' }, t('fallbackNone'))];
        for (const m of selectable) {
          // 已經被別的順位選走的模型不再列出來：同一個模型排在
          // 兩個順位沒有意義，只會讓使用者以為有兩層保險。
          const takenElsewhere = (fallbackState.models ?? []).some((id, idx) => id === m.id && idx !== i);
          if (takenElsewhere) continue;
          options.push(h('option', { key: m.id, value: m.id }, m.id));
        }
        fallbackSlots.push(
          h(
            'label',
            { className: 'ocoa-fallback-slot', key: `slot-${i}` },
            h('span', { className: 'ocoa-fallback-slot-label' }, t('fallbackSlot', { n: i + 1 })),
            h(
              'select',
              {
                className: 'ocoa-input ocoa-fallback-select',
                value: current,
                disabled: busy !== '',
                onChange: (event) => setSlot(i, event.target.value)
              },
              options
            )
          )
        );
      }

      const modelRow = (m) => {
        const rk = m.probed && !m.ok ? reasonKey(m.reason) : null;
        // 失敗原因只放進展開區，主列只留狀態。
        const detail = !m.probed
          ? t('statusUnprobed')
          : m.ok
            ? ''
            : rk
              ? t(rk)
              : m.status
                ? `HTTP ${m.status}`
                : t('rUnknown');
        // 上游原始回應。
        //
        // 中文標籤是我們的解讀，而解讀可能錯（實測就錯過：把「上下文超限」
        // 與「帳號權限」都講成「模型已下線」，害人往錯方向修）。原始文字不會錯，
        // 而且可以直接拿去搜尋。所以失敗的列一定要把它帶出來。
        //
        // 只在失敗時顯示：成功的模型沒有錯誤訊息，佔位子只是雜訊。
        const raw = !m.probed || m.ok ? '' : (m.detail || '').trim();
        const contextDraft = contextDraftFor(m);
        const contextSourceKey = m.contextSource === 'custom'
          ? 'contextSourceCustom'
          : m.contextSource === 'opencode'
            ? 'contextSourceOpenCode'
            : 'contextSourceFallback';
        const contextDirty = contextDraftChanged(m, contextDraft);
        const open = expandedModel === m.id;

        return h(
          'tbody',
          { key: m.id, className: 'ocoa-model-group' },
          h(
            'tr',
            { key: m.id + ':row', className: `ocoa-model-row${open ? ' is-open' : ''}` },
            // 勾選欄在最左邊：這是使用者對這張表最主要、也最常做的動作，
            // 眼睛掃的是「哪幾個打勾」，所以它該站在行的起點。
            h(
              'td',
              { className: 'ocoa-pick' },
              h('input', {
                type: 'checkbox',
                className: 'ocoa-pick-box',
                checked: m.shown === true,
                disabled: !pickerEnabled(m),
                'aria-label': `${t('pickerShow')} — ${m.id}`,
                title: m.available ? t('pickerShow') : t('pickerHidden'),
                'data-model-id': m.id,
                onChange: (event) => togglePicker(m.id, event.target.checked)
              })
            ),
            h(
              'td',
              { className: 'ocoa-model' },
              h(
                'span',
                {
                  className: open ? 'ocoa-model-toggle' : 'ocoa-model-id',
                  'aria-expanded': open ? true : undefined,
                  title: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id
                },
                m.name && m.name !== m.id ? `${m.name} · ${m.id}` : m.id
              )
            ),
            h(
              'td',
              null,
              h(
                'div',
                { className: 'ocoa-status', title: detail || undefined },
                h(
                  'span',
                  {
                    // 三種狀態，而不是原本的兩種。
                    //
                    // 「失敗」對 429 是錯的標籤：模型有效，只是這次排不進去。
                    // 把它染成紅色的「失敗」，使用者會以為模型壞了，去換一個
                    // 其實一樣好的模型。用黃色的「限流」講清楚：模型在，稍等。
                    className: `ocoa-badge ${m.ok ? 'ok' : !m.probed ? 'dim' : (m.valid ? 'warn' : 'off')}`
                  },
                  m.ok
                    ? t('statusOk')
                    : !m.probed
                      ? t('statusUnprobed')
                      : m.valid
                        ? t('statusLimited')
                        : t('statusFail')
                ),
                m.probed && !m.ok && detail
                  ? h('span', { className: 'ocoa-status-reason' }, detail)
                  : null
              )
            ),
            h(
              'td',
              { className: 'ocoa-num' },
              h(
                'button',
                {
                  type: 'button',
                  className: `ocoa-context-btn${m.contextOverride != null ? ' is-custom' : ''}`,
                  title: t('contextClickToEdit'),
                  onClick: (e) => {
                    e.stopPropagation();
                    openContextModal(m);
                  }
                },
                h('span', null, numberLabel(m.contextWindow ?? m.catalogContextWindow))
              )
            ),
            h(
              'td',
              { className: 'ocoa-num' },
              m.ms === null || m.ms === undefined ? '–' : `${m.ms} ms`
            )
          ),
          open
            ? h(
                'tr',
                { key: m.id + ':expand', className: 'ocoa-model-expand' },
                h(
                  'td',
                  { colSpan: 5 },
                  h(
                    'div',
                    { className: 'ocoa-expand-body' },
                    detail ? h('div', { className: 'ocoa-expand-reason' }, detail) : null,
                    m.probed
                      ? h(
                          'div',
                          { className: 'ocoa-diagnostic-meta' },
                          t(m.available ? 'pickerAvailable' : 'pickerHidden'),
                          m.status !== null && m.status !== undefined ? ` · HTTP ${m.status}` : '',
                          m.probedAt
                            ? ` · ${t('modelProbedAt', { when: formatWhen(m.probedAt, localeId) })}`
                            : '',
                          m.failureStreak > 0
                            ? ` · ${t('modelFailureStreak', { count: m.failureStreak })}`
                            : ''
                        )
                      : null,
                    raw
                      ? h(
                          'div',
                          { className: 'ocoa-raw', title: raw },
                          h('span', { className: 'ocoa-raw-label' }, 'HTTP ' + (m.status ?? '?')),
                          ' ',
                          h('code', null, raw)
                        )
                      : null,
                    h(
                      'details',
                      { className: 'ocoa-context-editor' },
                      h(
                        'summary',
                        null,
                        t('contextSummary', {
                          effective: numberLabel(m.contextWindow ?? m.catalogContextWindow),
                          source: t(contextSourceKey)
                        })
                      ),
                      h(
                        'div',
                        { className: 'ocoa-context-panel' },
                        h(
                          'div',
                          { className: 'ocoa-context-default' },
                          t('contextPublished', { value: numberLabel(m.catalogContextWindow ?? m.contextWindow) })
                        ),
                        // 上游的單次輸出上限。使用者問「最大值是多少」時，問的
                        // 常常是這個而不是上下文；目錄有給（`limit.output`），
                        // 但以前只活在 describe() 裡，畫面上完全看不到。
                        Number.isFinite(m.maxOutputTokens)
                          ? h(
                              'div',
                              { className: 'ocoa-context-default' },
                              t('contextMaxOutput', { value: numberLabel(m.maxOutputTokens) })
                            )
                          : null,
                        h('p', { className: 'ocoa-context-hint' }, t('contextHint')),
                        h(
                          'label',
                          { className: 'ocoa-context-field' },
                          h('span', null, t('contextMode')),
                          h(
                            'select',
                            {
                              className: 'ocoa-input',
                              value: contextDraft.mode,
                              disabled: busy !== '',
                              onChange: (event) => updateContextDraft(m, { mode: event.target.value })
                            },
                            h('option', { value: 'default' }, t('contextDefault')),
                            h('option', { value: 'custom' }, t('contextCustom'))
                          )
                        ),
                        contextDraft.mode === 'custom'
                          ? h(
                              'label',
                              { className: 'ocoa-context-field' },
                              h('span', null, t('contextValue')),
                              h('input', {
                                className: 'ocoa-input ocoa-context-number',
                                type: 'number',
                                min: 1024,
                                max: 100000000,
                                step: 1,
                                value: contextDraft.value,
                                disabled: busy !== '',
                                onChange: (event) => updateContextDraft(m, { value: event.target.value })
                              })
                            )
                          : null,
                        h(
                          'div',
                          { className: 'ocoa-actions' },
                          h(
                            'button',
                            {
                              className: 'ocoa-btn',
                              disabled: busy !== '' || !contextDirty,
                              onClick: () => saveContext(m)
                            },
                            busy === 'context' ? t('contextSaving') : t('contextSave')
                          ),
                          h(
                            'button',
                            {
                              className: 'ocoa-btn ghost',
                              disabled: busy !== '' || m.contextOverride == null,
                              onClick: () => resetContext(m)
                            },
                            t('contextReset')
                          )
                        )
                      )
                    )
                  )
                )
              )
            : null
        );
      };

      const head = h(
        'div',
        { className: 'ocoa-head' },
        h(
          'div',
          { className: 'ocoa-title-row' },
          h('span', { className: 'ocoa-title' }, t('title')),
          h(Chip, { tone: chip.tone, text: t(chip.key) }),
          // 語言切換鍵推到最右側。只影響本分頁，不動 DSH 全域語言。
          h(LanguageSwitcher, {
            choice: languageChoice ?? 'auto',
            localeId,
            t,
            onChange: (value) => {
              setLanguageChoice(value);
              writeStoredLanguage(value);
            }
          })
        )
      );

        /* -------------------------------------------- 授權狀態 ＋ 帳號 */
        // 這兩件事其實是同一件事：登入的是哪個帳號、那個帳號還有效嗎。
        // 分成兩張卡時，使用者得在兩張卡之間來回比對「現在生效的」和「有幾個」，
        // 而且兩張卡的按鈕長得一樣（重新登入 vs 新增帳號），很容易按錯。
        const accountPane = h(
          'div',
          { className: 'ocoa-card' },
          h(
            'div',
            { className: 'ocoa-card-head' },
            h('span', { className: 'ocoa-card-title' }, t('sectionAccount')),
            h(
              'div',
              { className: 'ocoa-actions' },
              h(
                'button',
                {
                  className: 'ocoa-btn',
                  onClick: () => act('refresh', 'refresh'),
                  disabled: busy !== ''
                },
                busy === 'refresh' ? t('refreshing') : t('verify')
              ),
              h(
                'button',
                {
                  className: 'ocoa-btn',
                  onClick: () => act('importLocal', 'accounts/import-local'),
                  disabled: busy !== ''
                },
                busy === 'importLocal' ? t('importingLocal') : t('importLocal')
              ),
              h(
                'button',
                {
                  className: 'ocoa-btn primary',
                  onClick: () => act('login', 'login'),
                  disabled: busy !== ''
                },
                busy === 'login' ? t('loggingIn') : cred.present ? t('reauth') : t('login')
              ),
              cred.present
                ? h(
                    'button',
                    {
                      className: 'ocoa-btn ghost',
                      onClick: () => act('logout', 'logout'),
                      disabled: busy !== ''
                    },
                    t('logout')
                  )
                : null
            )
          ),

          // 三個事實並排成橫向條：它們是一組的（來源／到期／可否自動續），
          // 直排會讓一張卡佔掉兩倍高度，卻沒有比較好讀。
          h(
            'dl',
            { className: 'ocoa-facts' },
            Fact({ label: t('credSource'), children: cred.present ? sourceLabel : t('credAbsent') }),
            Fact({ label: t('credExpiry'), children: expiryText }),
            Fact({
              label: t('credRefreshable'),
              children: cred.present ? (cred.hasRefresh ? t('credYes') : t('credNo')) : '–'
            })
          ),

          // 憑證有效且一切正常時，這行只是把「可用」再說一次，而模型分類就在
          // 下面——留著只會多佔一行。只在真的有狀況時顯示。
          (() => {
            const hk = healthMessageKey(status.health);
            if (!hk || status.health === 'ready') return null;
            return h('div', { className: 'ocoa-msg' }, t(hk));
          })(),

          !cred.present ? h('div', { className: 'ocoa-note' }, t('signedOutHint')) : null,

          // 登入進行中：顯示裝置代碼與驗證網址。
          pending
            ? h(
                'div',
                { className: 'ocoa-codebox' },
                h('span', null, t('userCode')),
                h('span', { className: 'ocoa-usercode' }, pending.userCode),
                h(
                  'button',
                  { className: 'ocoa-btn ghost', onClick: () => copy(pending.userCode, 'code') },
                  copied === 'code' ? t('copied') : t('copy')
                ),
                h(
                  'a',
                  {
                    className: 'ocoa-link ocoa-url',
                    href: pending.verificationUrl,
                    target: '_blank',
                    rel: 'noopener'
                  },
                  pending.verificationUrl
                ),
                h(
                  'button',
                  {
                    className: 'ocoa-btn ghost',
                    onClick: () => window.open(pending.verificationUrl, '_blank', 'noopener')
                  },
                  t('openAgain')
                ),
                h(
                  'button',
                  {
                    className: 'ocoa-btn ghost',
                    disabled: busy !== '',
                    onClick: () => void act('cancelLogin', 'login/cancel')
                  },
                  busy === 'cancelLogin' ? t('cancelling') : t('cancelLogin')
                )
              )
            : null,

          // 只留下「去哪裡確認」的指示；代碼本身已經在上面用大字顯示，這裡再
          // 接一次只會讓同一串字在同一張卡片裡出現兩次。
          pending ? h('div', { className: 'ocoa-note' }, t('loginHint')) : null,

          // 背景輪詢的失敗不會回到當初那次 POST。狀態裡的 loginError 才是
          // 那一次的結果；進行中的登入仍以裝置碼為準，不把舊失敗疊在上面。
          !pending && loginFailureText(t, status.loginError)
            ? h('div', { className: 'ocoa-msg' }, `⚠ ${loginFailureText(t, status.loginError)}`)
            : null,

          message
            ? h(
                'div',
                { className: 'ocoa-msg' },
                message.kind === 'error' ? `⚠ ${message.text}` : `ⓘ ${message.text}`
              )
            : null,

          h('hr', { className: 'ocoa-divider' }),

          /* 帳號清單：接在同一張卡的下半部。 */
          h(
            'div',
            { className: 'ocoa-card-head' },
            h('span', { className: 'ocoa-subhead' }, t('sectionAccounts')),
            addAccountOpen
              ? h(
                  'div',
                  { className: 'ocoa-actions' },
                  h('input', {
                    className: 'ocoa-input',
                    type: 'text',
                    value: accountLabel,
                    placeholder: t('accountLabelPlaceholder'),
                    'aria-label': t('accountLabel'),
                    autoFocus: true,
                    onChange: (event) => setAccountLabel(event.target.value)
                  }),
                  h(
                    'button',
                    { className: 'ocoa-btn primary', disabled: busy !== '', onClick: beginAddAccount },
                    busy === 'login' ? t('loggingIn') : t('accountStart')
                  ),
                  h(
                    'button',
                    { className: 'ocoa-btn ghost', disabled: busy !== '', onClick: cancelAddAccount },
                    t('accountCancel')
                  )
                )
              : h(
                  'button',
                  {
                    className: 'ocoa-btn',
                    disabled: busy !== '',
                    onClick: () => {
                      setMessage(null);
                      setAddAccountOpen(true);
                    }
                  },
                  busy === 'login' ? t('loggingIn') : t('accountAdd')
                )
          ),

          accounts.length > 0
            ? h(
                'div',
                { className: 'ocoa-account-list' },
                ...accounts.map((account) => h(
                  'div',
                  { key: account.id, className: 'ocoa-account-row' },
                  h(
                    'span',
                    { className: 'ocoa-account-name', title: account.label || t('accountNoLabel') },
                    h('span', {
                      className: `ocoa-account-dot${account.isActive ? ' is-active' : ''}`,
                      'aria-hidden': 'true'
                    }),
                    h('span', { className: 'ocoa-account-label' }, account.label || t('accountNoLabel'))
                  ),
                  h(
                    'span',
                    { className: `ocoa-badge ${account.expired ? 'off' : 'ok'}` },
                    account.expired
                      ? t('accountExpired')
                      : account.expiresInSeconds == null
                        ? t('accountActive')
                        : t('accountExpiry', { time: dur(account.expiresInSeconds * 1000) })
                  ),
                  account.isActive
                    ? h(
                        'span',
                        { className: 'ocoa-account-active', 'aria-label': t('accountActive') },
                        h('span', { className: 'ocoa-dot', 'aria-hidden': 'true' }),
                        t('accountActive')
                      )
                    : h(
                        'button',
                        {
                          className: 'ocoa-btn',
                          disabled: busy !== '',
                          onClick: async () => {
                            await callApi('accounts/switch', 'POST', { id: account.id });
                            await load();
                          }
                        },
                        t('accountSwitch')
                      ),
                  h(
                    'button',
                    {
                      className: 'ocoa-btn ghost',
                      disabled: accounts.length <= 1,
                      onClick: () => setRemoveAccountModal(account)
                    },
                    t('accountRemove')
                  )
                ))
              )
            : h('div', { className: 'ocoa-note' }, t('signedOutHint')),

          h('div', { className: 'ocoa-msg' }, t('accountAddHint')),

          // 自動切換本質上是帳號行為，所以留在同一張卡裡；為了一個勾選框再開一張
          // 卡片只會讓頁面多一個分類。用細線與次標題跟上面的清單分開。
          h('hr', { className: 'ocoa-divider' }),
          h('span', { className: 'ocoa-subhead' }, t('sectionAutoSwitch')),
          h(
            'label',
            { className: 'ocoa-check' },
            h('input', {
              type: 'checkbox',
              checked: status?.autoSwitch?.enabled === true,
              disabled: busy !== '',
              onChange: (event) => toggleAutoSwitch(event.target.checked)
            }),
            t('autoSwitchEnable')
          ),
          h('div', { className: 'ocoa-note' }, t('autoSwitchHint'))
        );

        /* -------------------------------------------------------- 模型 */
        const modelsPane = h(
          'div',
          { className: 'ocoa-card' },
          h(
            'div',
            { className: 'ocoa-card-head' },
            h(
              'span',
              { className: 'ocoa-card-title' },
              // 不寫「模型」：頁籤已經寫了，卡片標題再寫一次是同一件事講兩遍。
              // 改成一句狀態說明，講「這張表現在是什麼」。
              t('modelsCaption')
            ),
            h(
              'div',
              { className: 'ocoa-actions' },
              // 「顯示全部」只在手動模式出現：自動模式下它已經是事實，
              // 多一顆按鈕只會讓「現在是哪種模式」更難判斷。
              picker?.mode === 'manual'
                ? h(
                    'button',
                    {
                      className: 'ocoa-btn ghost',
                      onClick: resetPicker,
                      disabled: busy !== ''
                    },
                    busy === 'picker-reset' ? t('pickerResetBusy') : t('pickerReset')
                  )
                : null,
              h(
                'button',
                {
                  className: 'ocoa-btn',
                  onClick: () => {
                    const isScoped = (activeFilter === 'available' || activeFilter !== 'all' || query.length > 0) && matched.length > 0;
                    const modelIds = isScoped ? matched.map((m) => m.id) : undefined;
                    act('probe', 'probe', modelIds ? { modelIds } : {});
                  },
                  disabled: busy !== ''
                },
                busy === 'probe'
                  ? t('probing')
                  : activeFilter === 'available' && matched.length > 0
                    ? t('reprobeAvailable', { n: matched.length })
                    : (activeFilter !== 'all' || query.length > 0) && matched.length > 0
                      ? t('reprobeFiltered', { n: matched.length })
                      : t('reprobe')
              )
            )
          ),

          // 勾選模式的說明。
          //
          // 這一行是必要的：勾選框本身看不出「勾了之後新模型還會不會自動
          // 冒出來」。手動模式下如果不說清楚，使用者會以為功能壞了——
          // 他明明期待新模型出現。所以模式要明講，兩個數字也要明講。
          picker
            ? h(
                'div',
                { className: 'ocoa-picker-mode' },
                h(
                  'span',
                  { className: `ocoa-badge ${picker.mode === 'manual' ? 'accent' : 'dim'}` },
                  picker.mode === 'manual' ? t('pickerManualShort') : t('pickerAutoShort')
                ),
                h(
                  'span',
                  { className: 'ocoa-picker-mode-text' },
                  picker.mode === 'manual'
                    ? t('pickerManual', { n: picker.shown?.length ?? 0, total: summary.available ?? 0 })
                    : t('pickerAuto')
                )
              )
            : null,

          h(
            'div',
            { className: 'ocoa-msg' },
            (probedWhen ? t('probedAgo', { when: probedWhen }) : t('neverProbed'))
              + ' · '
              + t('modelsAvailable', { ok: summary.valid ?? summary.available ?? 0, total: summary.total ?? 0 })
          ),

          // 上一輪被熔斷時，把範圍講清楚。
          //
          // 沒有這行的話，「13 個可用」配上「4 筆探測紀錄」看起來像探測壞掉；
          // 事實是第 4 個模型撞到限流就停手，剩下 42 個還沿用上次結果。
          (() => {
            const cut = summary.truncation;
            if (!cut || !(cut.total > 0)) return null;
            const key = cut.stopped === 'unreachable' ? 'truncatedUnreachable' : 'truncatedRateLimit';
            return h(
              'div',
              { className: 'ocoa-msg ocoa-msg-warn', 'data-probe-truncated': cut.stopped ?? 'unknown' },
              `⚠ ${t(key, { tested: cut.tested, total: cut.total })}`
            );
          })(),

          // 額度解除時間。
          //
          // 這是使用者最想要的一個數字：上游 429 會帶 retry-after，換算成
          // 「今天 08:15 解除（還有 1 小時 30 分）」，他才知道該等還是該換模型。
          // 上游沒給時誠實說沒給，不要編一個看起來合理的數字。
          (() => {
            const quota = status.quota;
            if (!quota || !Number.isFinite(quota.resetAt)) return null;
            const remaining = quota.resetAt - Date.now();
            if (remaining <= 0) {
              return h(
                'div',
                { className: 'ocoa-msg', 'data-quota-reset': 'expired' },
                `✓ ${t('quotaResetReady')}`
              );
            }
            return h(
              'div',
              { className: 'ocoa-msg ocoa-msg-warn', 'data-quota-reset': 'pending' },
              `⏳ ${t('quotaReset', {
                when: formatWhen(quota.resetAt, localeId),
                in: shortDuration(remaining, durUnits)
              })}`
            );
          })(),

          // 分類篩選：一條連續的分段選單，而不是散落的標籤。
          //
          // 為什麼是一條而不是四顆獨立膠囊：這些選項互斥（一次只看一種），
          // 互斥的東西就該長成同一個控制項；散開的膠囊會讓人以為可以複選。
          // 「全部」放在最前面，因為那是預設的認知起點，也是清掉篩選的出口。
          (() => {
            const mm = status.models ?? {};
            const groups = Array.isArray(mm.breakdown) ? mm.breakdown : [];
            const seg = (key, label, count, filterValue, tone, fullLabel) => h(
              'button',
              {
                type: 'button',
                key: key,
                className: `ocoa-seg${activeFilter === filterValue ? ' is-active' : ''}${tone ? ` is-${tone}` : ''}`,
                'data-model-filter': filterValue,
                'aria-pressed': activeFilter === filterValue,
                // 顯示短標籤，但 hover 與讀屏拿得到完整說法。
                title: fullLabel ?? label,
                'aria-label': `${label} (${count})${fullLabel && fullLabel !== label ? ` — ${fullLabel}` : ''}`,
                onClick: () => {
                  // 換分類時收起「顯示全部」，否則切到只有 3 筆的分類時，
                  // 畫面會停在「顯示較少」的狀態，看起來像還有東西沒展開。
                  setModelFilter(filterValue);
                  writeStoredFilter(filterValue);
                  setShowAll(false);
                }
              },
              count === null
                ? null
                : h('span', { className: 'ocoa-seg-count' }, String(count)),
              h('span', { className: 'ocoa-seg-label' }, label)
            );

            return h(
              'div',
              { className: 'ocoa-segments', role: 'group', 'aria-label': t('modelFilters') },
              seg('all', t('filterAll'), mm.total ?? 0, 'all', null),
              // 數字用 valid（上游有效），不是 available（已發佈給選擇器）。
              // 這個分類的語意是「哪些模型上游認得」，429 也算。
              seg('available', t('filterAvailable'), mm.valid ?? mm.available ?? 0, 'available', 'ok'),
              ...groups.map((group) => {
                // 用短標籤，不用完整句子：一排等寬格子裡混用「可用」與
                // 「模型目前不可用」，格寬會參差、選中項也會被撐寬。
                const sk = shortReasonKey(group.reason);
                const full = reasonKey(group.reason);
                return seg(
                  group.reason,
                  sk ? t(sk) : (full ? t(full) : group.label),
                  group.count,
                  group.reason,
                  null,
                  // 完整句子放進 title：短標籤省空間，但不該讓人失去解釋。
                  full ? t(full) : group.label
                );
              })
            );
          })(),

          h(
            'div',
            { className: 'ocoa-toolbar' },
            h('input', {
              className: 'ocoa-input',
              type: 'search',
              placeholder: t('searchPlaceholder'),
              value: filter,
              onChange: (e) => setFilter(e.target.value)
            }),
            // 篩選後仍有幾筆，就寫在這裡。使用者不必自己數表格有幾列，
            // 也才知道「看不到東西」是篩選太窄還是真的沒有資料。
            //
            // 分母用 summary.total（目錄總數）而不是 models.length：後者是
            // 「這一頁拿到幾筆」，跟分類上的 46 不是同一個數字，並列會自相矛盾。
            h(
              'span',
              { className: 'ocoa-toolbar-count' },
              t('filterCount', { shown: filtered.length, total: summary.total ?? models.length })
            )
          ),

          rows.length > 0
            ? h(
                'table',
                { className: 'ocoa-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { className: 'ocoa-pick' }, t('colPicker')),
                    h('th', null, t('colModel')),
                    h('th', null, t('colStatus')),
                    h('th', { className: 'ocoa-num' }, t('colContext')),
                    h('th', { className: 'ocoa-num' }, t('colLatency'))
                  )
                ),
                rows.map(modelRow)
              )
            : h('div', { className: 'ocoa-note' }, t('noMatch')),

          // 收合時只顯示前 8 列，按鈕要把「還有幾列沒顯示」講清楚。
          // 原本寫「顯示全部 46 個模型」，但畫面上已經有 8 列，讀起來像
          // 「上面那些不是全部」——事實是「還有 38 列」。
          filtered.length > MODELS_COLLAPSED
            ? h(
                'button',
                { className: 'ocoa-btn ghost', onClick: () => setShowAll((v) => !v) },
                showAll
                  ? t('showLess')
                  : t('showRest', { n: filtered.length - MODELS_COLLAPSED, total: filtered.length })
              )
            : null
        );

        /* -------------------------------------------------------- 進階 */
        // 備援與診斷都是「設定一次、之後很少動」的內容；各自一張卡會讓整頁變成
        // 六個分類。收進同一張卡，用次標題分隔，要找還是找得到。
        const bun = status.bun ?? {};
        const anon = status.anonymousChannel ?? {};
        const bunLast = bun.last
          ? `${bun.last.transport || 'bun'} · ${bun.last.model || ''}`
          : t('bunLastNone');
        const advancedPane = h(
          'div',
          { className: 'ocoa-card' },
          /* --- 1. Bun 執行環境 --- */
          h(
            'div',
            { className: 'ocoa-card-head' },
            h('span', { className: 'ocoa-card-title' }, t('sectionBun')),
            h(Chip, {
              tone: bun.installed ? 'ok' : 'off',
              text: bun.installed ? t('bunInstalled') : t('bunMissing')
            })
          ),

          h(
            'dl',
            { className: 'ocoa-facts' },
            Fact({
              label: t('bunEnabled'),
              children: !bun.installed ? t('bunMissing') : (bun.enabled ? t('bunUsed') : t('bunNode'))
            }),
            Fact({
              label: t('bunVersion'),
              children: bun.version ? `v${bun.version}` : '–'
            }),
            Fact({
              label: t('bunLast'),
              children: bunLast
            })
          ),

          bun.path
            ? h(
                'div',
                { className: 'ocoa-note ocoa-mono', style: { wordBreak: 'break-all' } },
                `PATH: ${bun.path}`
              )
            : null,

          h('div', { className: 'ocoa-note' }, t('bunHint')),

          bun.installed
            ? null
            : h(
                'div',
                { className: 'ocoa-note' },
                h('div', null, t('bunMissingHint')),
                h(
                  'div',
                  { className: 'ocoa-actions', style: { marginTop: '8px' } },
                  h(
                    'a',
                    {
                      className: 'ocoa-btn',
                      href: 'https://bun.sh',
                      target: '_blank',
                      rel: 'noopener noreferrer'
                    },
                    t('bunDownload')
                  ),
                  h(
                    'button',
                    {
                      className: 'ocoa-btn',
                      onClick: () => act('bunRescan', 'bun/rescan'),
                      disabled: busy !== ''
                    },
                    busy === 'bunRescan' ? t('bunRescanning') : t('bunRescan')
                  )
                )
              ),

          bun.installed
            ? h(
                'div',
                { className: 'ocoa-actions' },
                h(
                  'button',
                  {
                    className: 'ocoa-btn ghost',
                    onClick: () => act('bunRescan', 'bun/rescan'),
                    disabled: busy !== ''
                  },
                  busy === 'bunRescan' ? t('bunRescanning') : t('bunRescan')
                )
              )
            : null,

          h('hr', { className: 'ocoa-divider' }),

          /* --- 1.5 匿名通道 --- */
          h(
            'div',
            { className: 'ocoa-card-head' },
            h('span', { className: 'ocoa-subhead' }, t('sectionAnonymous')),
            h(Chip, {
              tone: anon.enabled ? 'warn' : 'off',
              text: anon.enabled ? t('anonOn') : t('anonOff')
            })
          ),
          h(
            'label',
            { className: 'ocoa-check' },
            h('input', {
              type: 'checkbox',
              checked: anon.enabled === true,
              disabled: busy !== '',
              onChange: (event) => act('anonymous', 'anonymous-channel', { enabled: event.target.checked })
            }),
            t('anonEnable')
          ),
          h('div', { className: 'ocoa-note' }, t('anonWarning')),

          h('hr', { className: 'ocoa-divider' }),

          /* --- 2. 模型備援 --- */
          h(
            'div',
            { className: 'ocoa-card-head' },
            h('span', { className: 'ocoa-subhead' }, t('sectionFallback')),
            h(
              'div',
              { className: 'ocoa-actions' },
              h(
                'button',
                {
                  className: 'ocoa-btn',
                  onClick: saveFallback,
                  disabled: busy !== '' || !fallbackDirty
                },
                busy === 'fallback' ? t('fallbackSaving') : t('fallbackSave')
              )
            )
          ),

          h(
            'label',
            { className: 'ocoa-check' },
            h('input', {
              type: 'checkbox',
              checked: fallbackState.enabled === true,
              disabled: busy !== '',
              onChange: (event) => toggleFallback(event.target.checked)
            }),
            t('fallbackEnable')
          ),

          fallbackState.enabled
            ? h('div', { className: 'ocoa-note' }, t('fallbackHint'))
            : h('div', { className: 'ocoa-note' }, t('fallbackOffNote')),

          fallbackState.enabled
            ? selectable.length > 0
              ? h('div', { className: 'ocoa-fallback-slots' }, fallbackSlots)
              : h('div', { className: 'ocoa-note' }, t('fallbackNeedProbe'))
            : null,

          h('hr', { className: 'ocoa-divider' }),

          /* --- 3. 診斷資訊 --- */
          h(
            'details',
            { className: 'ocoa-details' },
            h('summary', { className: 'ocoa-subhead' }, t('sectionDetails')),
            h(
              'dl',
              { className: 'ocoa-grid ocoa-grid-tight' },
              Row({ label: t('detailProvider'), children: status.provider?.id ?? '–' }),
              Row({ label: t('detailVersion'), children: status.version ?? '–' }),
              Row({ label: t('detailProbeInterval'), children: intervalLabel(cfg.probeIntervalMs) }),
              Row({ label: t('detailCatalogPoll'), children: intervalLabel(cfg.catalogPollMs) }),
              Row({ label: t('detailPixelBudget'), children: cfg.imagePixelBudget ?? '–' }),
              Row({ label: t('detailMaxBytes'), children: byteLabel(cfg.imageMaxBytes) }),
              Row({
                label: t('detailAutoDetect'),
                children: cfg.autoDetectModels ? t('on') : t('off')
              }),
              Row({
                label: t('detailGenerated'),
                children: formatWhen(status.generatedAt, localeId) ?? '–'
              })
            )
          )
        );

        /* ------------------------------------------------------- OpenCode Go 分頁 */
        const goPane = (() => {
          const go = status.go ?? {};
          const goState = go.connectionState || (go.enabled ? 'unconfigured' : 'disabled');
          const goChipMeta = {
            disabled: { tone: 'off', label: t('goStateDisabled') },
            unconfigured: { tone: 'off', label: t('goStateUnconfigured') },
            checking: { tone: 'warn', label: t('goStateChecking') },
            connected: { tone: 'ok', label: t('goStateConnected') },
            'invalid-key': { tone: 'bad', label: t('goStateInvalidKey') },
            'no-entitlement': { tone: 'bad', label: t('goStateNoEntitlement') },
            'permission-policy': { tone: 'bad', label: t('goStatePermissionPolicy') },
            'rate-limited': { tone: 'warn', label: t('goStateRateLimited') },
            'transient-error': { tone: 'warn', label: t('goStateTransient') },
            'redirect-blocked': { tone: 'bad', label: t('goStateRedirectBlocked') },
            'invalid-response': { tone: 'bad', label: t('goStateInvalidResponse') }
          }[goState] || { tone: 'off', label: t('goStateDisabled') };

          const goCred = go.credential ?? {};
          const credRefName = goCred.ref || 'OPENCODE_GO_API_KEY';
          const canSaveGoCred = goCred.canSave === true;
          const canClearGoCred = goCred.canClear === true;
          const hasSavedDshCred = Boolean(goCred.present && goCred.source === 'dsh-credentials');

          const submitGoKeySave = () => {
            const nextKey = goKeyInput.trim();
            if (!nextKey || !canSaveGoCred || busy !== '') return;
            setGoKeyInput('');
            setGoKeyEditing(false);
            void act('goCredSave', 'go/credential', { key: nextKey });
          };
          const submitGoKeyClear = () => {
            if (!canClearGoCred || !hasSavedDshCred || busy !== '') return;
            setGoKeyInput('');
            setGoKeyEditing(false);
            void act('goCredClear', 'go/credential/clear', {});
          };

          const formatReset = (resetsAt) => {
            if (resetsAt === null || resetsAt === undefined) return null;
            const ms = typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt);
            if (!Number.isFinite(ms)) return String(resetsAt);
            return formatWhen(ms, localeId) ?? String(resetsAt);
          };
          const formatWin = (label, win) => {
            if (!win || typeof win.percent !== 'number' || !Number.isFinite(win.percent)) {
              return `${label}: ${t('goWindowUnavailable')}`;
            }
            const parts = [`${label}: ${win.percent}%`];
            if (typeof win.status === 'string' && win.status.trim()) {
              parts.push(`(${win.status.trim()})`);
            }
            const resetText = formatReset(win.resetsAt);
            if (resetText) {
              parts.push(`· ${t('goWindowResetsAt', { when: resetText })}`);
            }
            return parts.join(' ');
          };
          const windows = go.usage?.windows;
          const windowLines = windows
            ? [
                formatWin(t('goWindowRolling'), windows.rolling),
                formatWin(t('goWindowWeekly'), windows.weekly),
                formatWin(t('goWindowMonthly'), windows.monthly)
              ]
            : [t('goWindowUnavailable')];

          const previewList = Array.isArray(go.previewModels) ? go.previewModels : [];
          const isConnectedGo = go.enabled === true && goState === 'connected';

          const mapBackendReason = (code, m) => {
            switch (code) {
              case 'inactive-status':
                return t('goReasonInactiveStatus', { status: m?.status || '?' });
              case 'missing-type':
                return t('goReasonMissingType');
              case 'unsupported-type':
                return t('goReasonUnsupportedType', { type: m?.type || '?' });
              case 'missing-limits':
                return t('goReasonMissingLimits');
              case 'non-text-modality':
                return t('goReasonNonTextModality');
              case 'invalid-model':
                return t('goReasonInvalidModel');
              default:
                return String(code);
            }
          };

          const resolveGoModelStatus = (m) => {
            const rawReasons = Array.isArray(m?.pickerReasons) ? m.pickerReasons : [];
            const mappedReasons = rawReasons.map((code) => mapBackendReason(code, m));
            const hasBackendPublish = typeof m?.pickerPublished === 'boolean';
            const hasBackendEligible = typeof m?.pickerEligible === 'boolean';
            const eligible = hasBackendEligible ? m.pickerEligible : false;
            const published = isConnectedGo && (hasBackendPublish ? m.pickerPublished : false);

            if (published) {
              return { eligible: true, inPicker: true, reasons: [] };
            }
            const reasons = [...mappedReasons];
            if (!isConnectedGo) {
              reasons.unshift(t('goReasonNotConnected'));
            } else if (reasons.length === 0) {
              reasons.push(hasBackendEligible && !eligible ? t('goReasonIneligible') : t('goReasonNotVerified'));
            }
            return { eligible: isConnectedGo && eligible, inPicker: false, reasons };
          };

          const renderGoCatalog = () => {
            const enriched = previewList.map((m) => ({ model: m, ...resolveGoModelStatus(m) }));
            const pickerCount = enriched.filter((entry) => entry.inPicker).length;
            const previewOnlyCount = enriched.length - pickerCount;
            const goQuery = goSearch.trim().toLowerCase();

            const matchedGo = enriched.filter(({ model: m, inPicker }) => {
              if (goFilter === 'picker' && !inPicker) return false;
              if (goFilter === 'preview' && inPicker) return false;
              if (goQuery) {
                const hay = `${m.id || ''} ${m.name || ''} ${m.type || ''}`.toLowerCase();
                if (!hay.includes(goQuery)) return false;
              }
              return true;
            });

            const sortedGo = [...matchedGo].sort((a, b) => {
              const ea = a.inPicker ? 0 : (a.eligible ? 1 : 2);
              const eb = b.inPicker ? 0 : (b.eligible ? 1 : 2);
              return ea - eb;
            });

            const goVisible = goShowAll ? sortedGo : sortedGo.slice(0, MODELS_COLLAPSED);
            const goExpandedOutsideWindow = !goShowAll
              && goExpandedModel !== null
              && sortedGo.some(({ model: m }) => m.id === goExpandedModel)
              && !goVisible.some(({ model: m }) => m.id === goExpandedModel);
            const goRows = goExpandedOutsideWindow ? sortedGo : goVisible;

            const goSeg = (filterValue, label, count, tone) => h(
              'button',
              {
                type: 'button',
                key: filterValue,
                className: `ocoa-seg${goFilter === filterValue ? ' is-active' : ''}${tone ? ` is-${tone}` : ''}`,
                'data-go-filter': filterValue,
                'aria-pressed': goFilter === filterValue,
                'aria-label': `${label} (${count})`,
                onClick: () => {
                  setGoFilter(filterValue);
                  setGoShowAll(false);
                }
              },
              h('span', { className: 'ocoa-seg-count' }, String(count)),
              h('span', { className: 'ocoa-seg-label' }, label)
            );

            const goModelRow = ({ model: m, eligible, inPicker, reasons }) => {
              const open = goExpandedModel === m.id;
              const toggleOpen = () => setGoExpandedModel((prev) => (prev === m.id ? null : m.id));
              const displayLabel = m.name || m.id;
              const reasonSummary = reasons.join(' · ');
              const toggleGoShown = (event) => {
                event.stopPropagation();
                if (!eligible || busy !== '') return;
                void act(`go-picker:${m.id}`, 'go/picker', { modelId: m.id, shown: !inPicker });
              };

              const capLabels = [];
              if (m.capabilities?.toolCall === true) capLabels.push(t('goCapTools'));
              if (m.capabilities?.reasoning === true) capLabels.push(t('goCapReasoning'));
              if (m.capabilities?.attachment === true) capLabels.push(t('goCapAttachment'));
              const capSummary = capLabels.length > 0 ? capLabels.join(' · ') : '–';

              const pills = [];
              pills.push(m.type || t('goModelTypeUnknown'));
              if (Number.isSafeInteger(m.limit?.context)) {
                pills.push(t('goContextCap', { value: numberLabel(m.limit.context) }));
              }
              if (Number.isSafeInteger(m.limit?.output)) {
                pills.push(t('goOutputCap', { value: numberLabel(m.limit.output) }));
              }
              if (m.capabilities?.toolCall === true) pills.push(t('goCapTools'));
              if (m.capabilities?.reasoning === true) pills.push(t('goCapReasoning'));
              if (m.capabilities?.attachment === true) pills.push(t('goCapAttachment'));
              if (Array.isArray(m.modalities?.input) && m.modalities.input.length > 0) {
                pills.push(t('goModalityInput', { list: m.modalities.input.join(', ') }));
              }

              const metaParts = [t('goExpandModelId', { id: m.id })];
              if (m.name && m.name !== m.id) metaParts.push(t('goExpandModelName', { name: m.name }));
              if (m.ownedBy) metaParts.push(t('goExpandProvider', { owner: m.ownedBy }));
              if (Number.isSafeInteger(m.limit?.input)) {
                metaParts.push(t('goExpandInputLimit', { value: numberLabel(m.limit.input) }));
              }
              if (Array.isArray(m.modalities?.input) && m.modalities.input.length > 0) {
                metaParts.push(t('goExpandModalityIn', { list: m.modalities.input.join(', ') }));
              }
              if (Array.isArray(m.modalities?.output) && m.modalities.output.length > 0) {
                metaParts.push(t('goExpandModalityOut', { list: m.modalities.output.join(', ') }));
              }

              return h(
                'tbody',
                { key: m.id, className: 'ocoa-model-group' },
                h(
                  'tr',
                  {
                    key: `${m.id}:row`,
                    className: `ocoa-model-row${open ? ' is-open' : ''}`,
                    onClick: toggleOpen
                  },
                  h(
                    'td',
                    {
                      className: 'ocoa-col-check',
                      onClick: (event) => event.stopPropagation()
                    },
                    h('input', {
                      type: 'checkbox',
                      className: 'ocoa-checkbox',
                      checked: inPicker,
                      disabled: !eligible || busy !== '',
                      'aria-label': m.id,
                      title: eligible ? (inPicker ? t('goStatusInPicker') : t('goStatusPreviewOnly')) : reasonSummary,
                      onChange: toggleGoShown
                    })
                  ),
                  h(
                    'td',
                    { className: 'ocoa-model' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ocoa-go-model-btn',
                        'aria-expanded': open,
                        title: m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id,
                        onClick: (event) => {
                          event.stopPropagation();
                          toggleOpen();
                        }
                      },
                      h('span', { className: 'ocoa-go-caret', 'aria-hidden': true }, open ? '▾' : '▸'),
                      h('span', { className: open ? 'ocoa-model-toggle' : 'ocoa-model-id' }, displayLabel),
                      !eligible
                        ? h('span', { className: 'ocoa-badge dim', style: { marginLeft: '6px' } }, t('goStatusPreviewOnly'))
                        : null
                    )
                  ),
                  h(
                    'td',
                    { className: 'ocoa-num' },
                    Number.isSafeInteger(m.limit?.context) ? numberLabel(m.limit.context) : '–'
                  ),
                  h(
                    'td',
                    { className: 'ocoa-num' },
                    Number.isSafeInteger(m.limit?.output) ? numberLabel(m.limit.output) : '–'
                  )
                ),
                open
                  ? h(
                      'tr',
                      { key: `${m.id}:expand`, className: 'ocoa-model-expand' },
                      h(
                        'td',
                        { colSpan: 4 },
                        h(
                          'div',
                          { className: 'ocoa-expand-body' },
                          !inPicker
                            ? h('div', { className: 'ocoa-expand-reason' }, t('goPreviewOnlyNote', { reasons: reasonSummary }))
                            : h('div', { className: 'ocoa-diagnostic-meta' }, t('goPickerEligibleNote')),
                          h(
                            'div',
                            { className: 'ocoa-diagnostic-meta' },
                            inPicker
                              ? (m.pickerImageSupported === true ? t('goModelSupportImage') : t('goModelSupportTextOnly'))
                              : t('goSupportScopeNote')
                          ),
                          h('div', { className: 'ocoa-diagnostic-meta' }, t('goCatalogMetaLabel', { meta: metaParts.join(' · ') })),
                          h(
                            'div',
                            { className: 'ocoa-go-meta' },
                            pills.map((p, idx) => h('span', { className: 'ocoa-go-pill', key: `${m.id}-pill-${idx}` }, p))
                          )
                        )
                      )
                    )
                  : null
              );
            };

            return h(
              'div',
              { className: 'ocoa-go-catalog' },
              previewList.length > 0
                ? [
                    h(
                      'div',
                      { key: 'go-segments', className: 'ocoa-segments', role: 'group', 'aria-label': t('modelFilters') },
                      goSeg('all', t('goFilterAll'), previewList.length, null),
                      goSeg('picker', t('goFilterPicker'), pickerCount, 'ok'),
                      goSeg('preview', t('goFilterPreview'), previewOnlyCount, null)
                    ),
                    h(
                      'div',
                      { key: 'go-toolbar', className: 'ocoa-toolbar' },
                      h('input', {
                        className: 'ocoa-input',
                        type: 'search',
                        placeholder: t('searchPlaceholder'),
                        value: goSearch,
                        onChange: (event) => setGoSearch(event.target.value)
                      }),
                      h(
                        'span',
                        { className: 'ocoa-toolbar-count' },
                        t('filterCount', { shown: sortedGo.length, total: previewList.length })
                      )
                    ),
                    goRows.length > 0
                      ? h(
                          'div',
                          { key: 'go-table-scroll', className: 'ocoa-go-table-scroll' },
                          h(
                            'table',
                            { key: 'go-table', className: 'ocoa-table ocoa-go-table' },
                            h(
                              'thead',
                              null,
                              h(
                                'tr',
                                null,
                                h('th', { className: 'ocoa-col-check' }, t('colPicker')),
                                h('th', null, t('colModel')),
                                h('th', { className: 'ocoa-num' }, t('colContext')),
                                h('th', { className: 'ocoa-num' }, t('goColOutput'))
                              )
                            ),
                            goRows.map(goModelRow)
                          )
                        )
                      : h('div', { key: 'go-nomatch', className: 'ocoa-note' }, t('goNoMatch')),
                    sortedGo.length > MODELS_COLLAPSED
                      ? h(
                          'button',
                          {
                            key: 'go-showall',
                            type: 'button',
                            className: 'ocoa-btn ghost',
                            onClick: () => setGoShowAll((v) => !v)
                          },
                          goShowAll
                            ? t('showLess')
                            : t('showRest', { n: sortedGo.length - MODELS_COLLAPSED, total: sortedGo.length })
                        )
                      : null
                  ]
                : h('div', { className: 'ocoa-note' }, t('goPreviewEmpty'))
            );
          };

          const renderUsageCard = (key, label, win) => {
            const hasPct = Boolean(win && typeof win.percent === 'number' && Number.isFinite(win.percent));
            const pct = hasPct ? Math.max(0, Math.min(100, win.percent)) : 0;
            const tone = !hasPct ? 'ok' : (pct >= 90 ? 'bad' : (pct >= 70 ? 'warn' : 'ok'));
            const resetText = hasPct ? (formatReset(win.resetsAt) || '–') : t('goWindowUnavailable');
            return h(
              'div',
              { key, className: 'ocoa-go-usage-card' },
              h(
                'div',
                { className: 'ocoa-go-usage-head' },
                h('span', null, label),
                h('span', { className: `ocoa-go-usage-pct is-${tone}` }, hasPct ? `${win.percent}%` : '–')
              ),
              h(
                'div',
                { className: 'ocoa-go-usage-bar' },
                h('div', {
                  className: `ocoa-go-usage-fill is-${tone}`,
                  style: { width: `${hasPct ? Math.max(pct, pct > 0 ? 3 : 0) : 0}%` }
                })
              ),
              h('div', { className: 'ocoa-go-usage-reset', title: resetText }, resetText)
            );
          };

          const showKeyDrawer = !hasSavedDshCred || goKeyEditing;

          return h(
            'div',
            { className: 'ocoa-card ocoa-go-section', 'data-go-state': goState },
            h(
              'div',
              { className: 'ocoa-card-head' },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                h('span', { className: 'ocoa-card-title' }, 'OpenCode Go'),
                h(Chip, { tone: goChipMeta.tone, text: goChipMeta.label }),
                go.checkedAt
                  ? h('span', { className: 'ocoa-msg', style: { margin: 0 } }, formatWhen(go.checkedAt, localeId) ?? '–')
                  : null
              ),
              h(
                'div',
                { className: 'ocoa-actions' },
                go.enabled && go.picker?.mode === 'manual'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'ocoa-btn ghost',
                        disabled: busy !== '',
                        onClick: () => act('go-picker-reset', 'go/picker', { mode: 'auto' })
                      },
                      busy === 'go-picker-reset' ? t('pickerResetBusy') : t('pickerReset')
                    )
                  : null,
                hasSavedDshCred
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'ocoa-btn',
                        'aria-expanded': showKeyDrawer,
                        disabled: busy !== '',
                        onClick: () => {
                          setGoKeyInput('');
                          setGoKeyEditing((v) => !v);
                        }
                      },
                      t('goKeyDrawer')
                    )
                  : null,
                go.enabled
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'ocoa-btn',
                        disabled: busy !== '',
                        onClick: () => act('goRefresh', 'go/refresh')
                      },
                      busy === 'goRefresh' ? t('goRefreshing') : t('goRefresh')
                    )
                  : null
              )
            ),
            go.enabled
              ? (windows
                  ? h(
                      'div',
                      { className: 'ocoa-go-usage-grid', 'data-go-usage': 'present' },
                      renderUsageCard('rolling', t('goWindowRolling'), windows.rolling),
                      renderUsageCard('weekly', t('goWindowWeekly'), windows.weekly),
                      renderUsageCard('monthly', t('goWindowMonthly'), windows.monthly)
                    )
                  : h('div', { className: 'ocoa-msg', 'data-go-usage': 'absent' }, t('goWindowUnavailable')))
              : null,
            go.error?.message
              ? h('div', { className: 'ocoa-msg bad' }, go.error.message)
              : null,
            showKeyDrawer
              ? h(
                  'div',
                  { className: 'ocoa-go-cred-box' },
                  h(
                    'div',
                    { className: 'ocoa-go-cred-head' },
                    h('span', null, t('goKeyFieldLabel', { ref: credRefName })),
                    h(Chip, {
                      tone: hasSavedDshCred ? 'ok' : 'off',
                      text: hasSavedDshCred ? t('goKeyStoredStatus') : t('goKeyUnsetStatus')
                    })
                  ),
                  h(
                    'div',
                    { className: 'ocoa-go-cred-row' },
                    h('input', {
                      type: 'password',
                      className: 'ocoa-input ocoa-go-cred-input',
                      value: goKeyInput,
                      placeholder: hasSavedDshCred ? t('goKeyStoredPlaceholder') : t('goKeyMissingPlaceholder'),
                      disabled: busy !== '' || !canSaveGoCred,
                      autoComplete: 'off',
                      spellCheck: false,
                      onChange: (event) => setGoKeyInput(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' && goKeyInput.trim() && canSaveGoCred && busy === '') {
                          event.preventDefault();
                          submitGoKeySave();
                        }
                      },
                      'aria-label': t('goKeyFieldLabel', { ref: credRefName })
                    }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ocoa-btn',
                        disabled: busy !== '' || !canSaveGoCred || !goKeyInput.trim(),
                        onClick: submitGoKeySave
                      },
                      busy === 'goCredSave' ? t('goKeySaving') : t('goKeySave')
                    ),
                    goKeyEditing
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'ocoa-btn',
                            disabled: busy !== '',
                            onClick: () => {
                              setGoKeyInput('');
                              setGoKeyEditing(false);
                            }
                          },
                          t('goKeyCancel')
                        )
                      : null
                  ),
                  !canSaveGoCred
                    ? h('div', { className: 'ocoa-note' }, t('goKeyWriteUnavailable'))
                    : null,
                  h(
                    'div',
                    { className: 'ocoa-go-cred-foot' },
                    h(
                      'div',
                      { className: 'ocoa-go-cred-notes' },
                      h('div', null, t('goApiOnlyNote')),
                      go.enabled ? h('div', null, t('goExtraUsageWarn')) : null
                    ),
                    (hasSavedDshCred || go.enabled)
                      ? h(
                          'div',
                          { className: 'ocoa-actions' },
                          hasSavedDshCred
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'ocoa-btn',
                                  disabled: busy !== '' || !canClearGoCred,
                                  onClick: submitGoKeyClear
                                },
                                busy === 'goCredClear' ? t('goKeyClearing') : t('goKeyClear')
                              )
                            : null,
                          go.enabled
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'ocoa-btn',
                                  disabled: busy !== '' || (previewList.length === 0 && !go.error && !go.checkedAt),
                                  onClick: () => act('goClear', 'go/clear')
                                },
                                t('goClear')
                              )
                            : null
                        )
                      : null
                  )
                )
              : null,
            !go.enabled
              ? h('div', { className: 'ocoa-note' }, t('goDisabledHint'))
              : null,
            go.enabled ? renderGoCatalog() : null
          );
        })();

        /* ------------------------------------------------------- 分頁 */
        // 拆成四個頁籤的理由：每個領域各自獨立，互不干擾。
        //   帳號：登入、換帳號——偶爾才動一次。
        //   模型：免費通道模型——幾乎每次開這個分頁都是為了它。
        //   進階：備援與診斷——設定一次就不管了。
        //   OpenCode Go：獨立訂閱憑證、用量視窗與 Go 模型目錄。
        const TABS = [
          { id: 'account', label: t('tabAccount'), pane: accountPane },
          { id: 'models', label: t('tabModels'), pane: modelsPane },
          { id: 'advanced', label: t('tabAdvanced'), pane: advancedPane },
          { id: 'go', label: t('tabGo'), pane: goPane }
        ];
        const activeTab = TABS.some((tab) => tab.id === tabState) ? tabState : 'models';
        const currentPane = TABS.find((tab) => tab.id === activeTab)?.pane ?? null;

        const contextModal = contextModalModel
          ? h(
              'div',
              {
                className: 'ocoa-modal-backdrop',
                onClick: (e) => {
                  if (e.target === e.currentTarget && busy !== 'context') closeContextModal();
                }
              },
              h(
                'div',
                { className: 'ocoa-modal-dialog', role: 'dialog', 'aria-modal': true },
                h(
                  'div',
                  { className: 'ocoa-modal-header' },
                  h(
                    'div',
                    null,
                    h('h3', { className: 'ocoa-modal-title' }, t('contextModalTitle')),
                    h('div', { className: 'ocoa-modal-sub' }, t('contextModalSub', { id: contextModalModel.id }))
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ocoa-modal-close',
                      title: t('contextCancel'),
                      disabled: busy === 'context',
                      onClick: closeContextModal
                    },
                    '✕'
                  )
                ),
                h(
                  'div',
                  { className: 'ocoa-modal-body' },
                  h(
                    'div',
                    { className: 'ocoa-modal-info' },
                    h('div', null, t('contextDefaultValue', {
                      value: numberLabel(contextModalModel.catalogContextWindow ?? contextModalModel.contextWindow ?? 200000)
                    })),
                    // 輸出上限也一起顯示：使用者問「最大值是多少」時，問的常常是
                    // 這個而不是上下文。上游目錄有給（`limit.output`），
                    // 但以前只活在 describe() 裡，畫面上看不到。
                    Number.isFinite(contextModalModel.maxOutputTokens)
                      ? h('div', { style: { marginTop: '4px' } }, t('contextMaxOutput', {
                          value: numberLabel(contextModalModel.maxOutputTokens)
                        }))
                      : null,
                    h('div', { style: { marginTop: '4px', opacity: 0.85 } }, t('contextHint'))
                  ),
                  h(
                    'label',
                    { className: 'ocoa-context-field' },
                    h('span', null, t('contextCustomLabel')),
                    h('input', {
                      className: 'ocoa-input ocoa-context-number',
                      type: 'number',
                      min: 1024,
                      max: 100000000,
                      step: 1,
                      value: contextInputVal,
                      disabled: busy === 'context',
                      autoFocus: true,
                      onChange: (e) => setContextInputVal(e.target.value)
                    })
                  )
                ),
                h(
                  'div',
                  { className: 'ocoa-modal-footer' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ocoa-btn ghost',
                      disabled: busy === 'context' || contextModalModel.contextOverride == null,
                      onClick: async () => {
                        await persistContext(contextModalModel, null);
                        closeContextModal();
                      }
                    },
                    t('contextResetToDefault')
                  ),
                  h(
                    'div',
                    { className: 'ocoa-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ocoa-btn ghost',
                        disabled: busy === 'context',
                        onClick: closeContextModal
                      },
                      t('contextCancel')
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ocoa-btn primary',
                        disabled: busy === 'context',
                        onClick: async () => {
                          const val = Number(contextInputVal);
                          if (!Number.isSafeInteger(val) || val < 1024 || val > 100000000) {
                            setMessage({ kind: 'error', text: t('contextInvalid') });
                            return;
                          }
                          await persistContext(contextModalModel, val);
                          closeContextModal();
                        }
                      },
                      busy === 'context' ? t('contextSaving') : t('contextSaveBtn')
                    )
                  )
                )
              )
            )
          : null;

        const removeModal = removeAccountModal
          ? h(
              'div',
              {
                className: 'ocoa-modal-backdrop',
                onClick: (e) => {
                  if (e.target === e.currentTarget && busy !== 'account-remove') setRemoveAccountModal(null);
                }
              },
              h(
                'div',
                { className: 'ocoa-modal-dialog', role: 'dialog', 'aria-modal': true },
                h(
                  'div',
                  { className: 'ocoa-modal-header' },
                  h(
                    'div',
                    null,
                    h('h3', { className: 'ocoa-modal-title' }, t('accountRemove')),
                    h('div', { className: 'ocoa-modal-sub' }, removeAccountModal.label || t('accountNoLabel'))
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ocoa-modal-close',
                      title: t('accountCancel'),
                      disabled: busy === 'account-remove',
                      onClick: () => setRemoveAccountModal(null)
                    },
                    '×'
                  )
                ),
                h(
                  'div',
                  { className: 'ocoa-modal-body' },
                  h('p', { className: 'ocoa-msg' }, t('accountRemoveConfirm'))
                ),
                h(
                  'div',
                  { className: 'ocoa-modal-footer' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ocoa-btn ghost',
                      disabled: busy === 'account-remove',
                      onClick: () => setRemoveAccountModal(null)
                    },
                    t('accountCancel')
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ocoa-btn primary',
                      style: { background: 'var(--ocoa-off, #ec1313)' },
                      disabled: busy === 'account-remove',
                      onClick: async () => {
                        setBusy('account-remove');
                        try {
                          await fetch(`${API}/accounts`, {
                            method: 'DELETE',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ id: removeAccountModal.id })
                          });
                          setRemoveAccountModal(null);
                          await load();
                        } finally {
                          setBusy('');
                        }
                      }
                    },
                    busy === 'account-remove' ? '…' : t('accountRemove')
                  )
                )
              )
            )
          : null;

        return h(
          'div',
          { className: 'ocoa-page' },
          head,
          h(
            'div',
            { className: 'ocoa-tabs', role: 'tablist', 'aria-label': t('title') },
            ...TABS.map((tab) => h(
              'button',
              {
                key: tab.id,
                type: 'button',
                role: 'tab',
                className: `ocoa-tab${tab.id === activeTab ? ' is-active' : ''}`,
                'data-tab': tab.id,
                'aria-selected': tab.id === activeTab,
                onClick: () => setTabState(tab.id)
              },
              tab.label,
              // 模型頁籤帶上可用數，這樣不必切過去也知道有沒有問題。
              tab.id === 'models' && Number.isFinite(summary.available)
                ? h('span', { className: 'ocoa-tab-badge' }, String(summary.available))
                : null
            ))
          ),
          h('div', { className: 'ocoa-pane', role: 'tabpanel' }, currentPane),
          contextModal,
          removeModal
        );
      }

    /* --------------------------------------------------------------- 註冊 */

    return {
      // `locale` 必須列入 inject：apply() 要透過它註冊字典，而碰到沒注入的
      // Cordis 服務會讓外掛啟動失敗，不是回傳 undefined。
      inject: ['slots', 'locale'],
      apply(ctx) {
        installStyle();
        // style 元素是本外掛擁有的資源，所以它的移除要登記成 effect，
        // 而不是卸載後留在 DOM 裡。
        ctx.effect(
          () => () => {
            const style = document.getElementById(STYLE_ID);
            if (style?.parentNode) style.parentNode.removeChild(style);
          },
          'opencode-next: settings style'
        );

        // DSH 只內建 `zh`（簡體）與 `en` 兩個語言 id，所以繁中字典在宣告之前
        // 沒有地方可放。addLanguage 會把「繁體中文」加進設定裡的語言清單；
        // fallback 用 `zh` 而不是 `en` 是刻意的：本外掛還沒翻到的鍵會顯示簡中，
        // 而不是整頁掉回英文。字典與語言宣告的先後順序不影響結果。
        //
        // 兩個呼叫都包了 try：可能已經有別的外掛佔用同一個 id，而這裡一拋錯
        // 就會讓整個外掛啟動失敗（跟碰到未注入的服務是同一種失敗模式）。
        for (const [label, setup] of [
          [
            'opencode-next: zh-Hant language',
            () => ctx.locale?.addLanguage?.({ id: 'zh-Hant', label: '繁體中文', fallback: 'zh' })
          ],
          ['opencode-next: dictionaries', () => ctx.locale?.register?.(NS, COPY)]
        ]) {
          try {
            const dispose = setup();
            if (typeof dispose === 'function') ctx.effect(() => dispose, label);
          } catch (error) {
            console.warn(`opencode-next: ${label} skipped —`, error);
          }
        }

        /* 側邊欄標籤與頁面語言的關係

           分頁由宿主自己負責，它的語言是宿主全域語言（DSH 只有 zh／en），
           本外掛沒辦法只改那一行而不動整個 DSH。所以這裡刻意**不**傳 `t`
           給頁面：頁面內容完全走自己的語言狀態（可在分頁內切換），而側邊欄
           那一行則跟隨宿主。這樣「切換本分頁語言」不會影響 DSH 其他部分，
           代價是側邊欄標籤可能與頁面內容語言不同——這是刻意的取捨。

           標籤文字用固定的外掛名稱：它本來就是品牌名，不是需要翻譯的文案，
           這樣無論宿主語言是什麼，那一行都是可預期的。 */
        const navLabel = 'OpenCode-Next';

        // 設定左側導覽列圖示裝飾器：把 DSH 預設的齒輪圖示換成 OpenCode-Next 專屬標誌。
        const NAV_ICON_SVG =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="76 76 360 360" width="16" height="16" fill="none" data-ocn-nav="1" style="flex:none;vertical-align:middle;">' +
          '<defs>' +
          '<linearGradient id="ocn-nav-gRing" gradientUnits="userSpaceOnUse" x1="0" y1="158" x2="0" y2="354">' +
          '<stop offset="0" stop-color="#A8B5C8"/>' +
          '<stop offset="1" stop-color="#5B6B82"/>' +
          '</linearGradient>' +
          '<linearGradient id="ocn-nav-gChev" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="#06B6D4"/>' +
          '<stop offset="1" stop-color="#2563EB"/>' +
          '</linearGradient>' +
          '<mask id="ocn-nav-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">' +
          '<rect width="512" height="512" fill="#fff"/>' +
          '<path d="M377.15 200.85 A78 78 0 1 0 377.15 311.15" fill="none" stroke="#000" stroke-width="64" stroke-linecap="round"/>' +
          '</mask>' +
          '</defs>' +
          '<g transform="translate(256 256) scale(1.12) translate(-256 -256)">' +
          '<g transform="translate(11 0)">' +
          '<circle cx="190" cy="256" r="78" fill="none" stroke="url(#ocn-nav-gRing)" stroke-width="40" mask="url(#ocn-nav-cut)"/>' +
          '<path d="M377.15 200.85 A78 78 0 1 0 377.15 311.15" fill="none" stroke="url(#ocn-nav-gRing)" stroke-width="40" stroke-linecap="round"/>' +
          '<path d="M334 234 L356 256 L334 278" fill="none" stroke="url(#ocn-nav-gChev)" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>' +
          '</g>' +
          '</g>' +
          '</svg>';

        function patchNavIcon() {
          if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
          if (!document.querySelector('[role="dialog"]')) return;
          for (const span of document.querySelectorAll('span')) {
            if (span.textContent && span.textContent.trim() === navLabel) {
              const btn = span.closest('button');
              if (btn) {
                const svg = btn.querySelector('svg');
                if (svg && svg.dataset.ocnNav !== '1') {
                  svg.outerHTML = NAV_ICON_SVG;
                }
              }
            }
          }
        }

        if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
          const timer = window.setInterval(patchNavIcon, 400);
          const onClick = () => queueMicrotask(patchNavIcon);
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('click', onClick, true);
          }
          if (typeof ctx.effect === 'function') {
            ctx.effect(() => () => {
              window.clearInterval?.(timer);
              if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
                document.removeEventListener('click', onClick, true);
              }
            }, 'opencode-next: nav icon timer');
          }
        }

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'opencode-next',
              // 14 是空著的（12 = antigravity、13 = agy-next、15 之後另有其人）。
              order: 14,
              label: () => navLabel,
              locale: NS
            },
            // 只傳 ctx；語言由 SettingsPage 自己解析。
            (props) => h(SettingsPage, { ctx, ...props })
          )
        );
      }
    };
  }
});
