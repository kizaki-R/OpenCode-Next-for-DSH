/**
 * 圖片投影：把 DSH 的 image 區塊變成 OpenAI 相容端點吃得下的 data URI。
 *
 * 這個模組刻意不 import 任何 `@deepseek-ai/*` 套件。attachment service 是宿主注入
 * 的服務（服務名 `attachments`），型別上跟本檔宣告的 duck type 相同即可；真的去
 * import 會讓外掛在沒有該套件的 profile 上直接載入失敗。
 */

/**
 * 依像素預算算出請求時的目標尺寸與位元組上限。
 *
 * 這必須是**純函式且確定**：attachment service 會用「附件 id + target」算 variant id
 * 做快取。同一張圖每次都得到同一個 target，才會命中同一份請求版本位元組。
 */
export function requestImageTarget(ref, pixelBudget, maxBytes) {
  const width = Number(ref?.width);
  const height = Number(ref?.height);
  const budget = Number(pixelBudget) > 0 ? Math.floor(Number(pixelBudget)) : 0;
  const limit = Number(maxBytes) > 0 ? Math.floor(Number(maxBytes)) : 0;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  const pixels = width * height;
  if (budget <= 0 || pixels <= budget) {
    return { width, height, maxBytes: limit > 0 ? limit : Math.max(1, Number(ref?.bytes) || 1) };
  }
  const scale = Math.sqrt(budget / pixels);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    maxBytes: limit > 0 ? limit : Math.max(1, Number(ref?.bytes) || 1)
  };
}

function dataUrl(mediaType, data) {
  const type = typeof mediaType === 'string' && mediaType !== '' ? mediaType : 'image/png';
  return `data:${type};base64,${Buffer.from(data).toString('base64')}`;
}

/**
 * 讀出一張請求版本圖片。
 *
 * 先走 `readImageRequest`（會依 target 縮放並快取）；服務不支援投影時退回原圖。
 * 兩條路都失敗就回傳 undefined——圖片解析失敗絕不能讓整個請求掛掉，呼叫端會把它
 * 換成佔位文字，模型至少知道漏了哪一份附件。
 */
async function readOne(attachments, ref, target, signal) {
  if (typeof attachments?.readImageRequest === 'function' && target !== undefined) {
    try {
      const projected = await attachments.readImageRequest(ref, target, signal);
      if (projected && projected.data) {
        return dataUrl(projected.mediaType ?? projected.attachment?.mediaType, projected.data);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // 投影不支援或編碼失敗：退回原圖。
    }
  }
  if (typeof attachments?.readImage === 'function') {
    try {
      const original = await attachments.readImage(ref, signal);
      if (original && original.data) {
        return dataUrl(original.ref?.mediaType ?? ref.mediaType, original.data);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  return undefined;
}

/**
 * 把一批附件參照讀成 `Map<attachmentId, dataURI>`。
 *
 * @param refs `collectImageRefs()` 的結果。
 * @param options `attachments`：attachment service（可能是 undefined）；`pixelBudget`
 *   與 `maxBytes`：投影預算；`signal`：取消訊號。
 */
export async function resolveImageDataUrls(refs, options = {}) {
  const urls = new Map();
  if (!(refs instanceof Map) || refs.size === 0) return urls;

  const attachments = options.attachments;
  if (attachments === undefined || attachments === null) return urls;

  const signal = options.signal;
  const pixelBudget = options.pixelBudget;
  const maxBytes = options.maxBytes;

  for (const [attachmentId, ref] of refs) {
    signal?.throwIfAborted?.();
    const target = requestImageTarget(ref, pixelBudget, maxBytes);
    const url = await readOne(attachments, ref, target, signal);
    if (typeof url === 'string' && url !== '') urls.set(attachmentId, url);
  }
  return urls;
}
