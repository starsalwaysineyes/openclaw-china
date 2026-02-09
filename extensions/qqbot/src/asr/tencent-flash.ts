import { createHmac } from "node:crypto";

const ASR_FLASH_HOST = "asr.cloud.tencent.com";
const ASR_FLASH_PATH_PREFIX = "/asr/flash/v1";
const ASR_FLASH_URL_PREFIX = `https://${ASR_FLASH_HOST}${ASR_FLASH_PATH_PREFIX}`;

export interface TencentFlashASRConfig {
  appId: string;
  secretId: string;
  secretKey: string;
  timeoutMs?: number;
}

interface TencentFlashResponseSentence {
  text?: string;
}

interface TencentFlashResponseItem {
  text?: string;
  sentence_list?: TencentFlashResponseSentence[];
}

interface TencentFlashResponse {
  code?: number;
  message?: string;
  request_id?: string;
  flash_result?: TencentFlashResponseItem[];
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildSignedQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeQueryValue(value)}`)
    .join("&");
}

function extractTranscript(payload: TencentFlashResponse): string {
  const items = Array.isArray(payload.flash_result) ? payload.flash_result : [];
  const lines: string[] = [];

  for (const item of items) {
    if (typeof item?.text === "string" && item.text.trim()) {
      lines.push(item.text.trim());
      continue;
    }
    const sentenceList = Array.isArray(item?.sentence_list) ? item.sentence_list : [];
    for (const sentence of sentenceList) {
      if (typeof sentence?.text === "string" && sentence.text.trim()) {
        lines.push(sentence.text.trim());
      }
    }
  }

  return lines.join("\n").trim();
}

export async function transcribeTencentFlash(params: {
  audio: Buffer;
  config: TencentFlashASRConfig;
}): Promise<string> {
  const { audio, config } = params;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const query = buildSignedQuery({
    engine_type: "16k_zh",
    secretid: config.secretId,
    timestamp,
    voice_format: "silk",
  });

  const signText = `POST${ASR_FLASH_HOST}${ASR_FLASH_PATH_PREFIX}/${config.appId}?${query}`;
  const authorization = createHmac("sha1", config.secretKey).update(signText).digest("base64");
  const url = `${ASR_FLASH_URL_PREFIX}/${config.appId}?${query}`;
  const timeoutMs = config.timeoutMs ?? 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/octet-stream",
      },
      body: audio,
      signal: controller.signal,
    });

    const bodyText = await response.text();
    let payload: TencentFlashResponse;
    try {
      payload = JSON.parse(bodyText) as TencentFlashResponse;
    } catch {
      throw new Error(`QQBot ASR response is not valid JSON: ${bodyText.slice(0, 300)}`);
    }

    if (!response.ok) {
      const message = payload.message ?? `HTTP ${response.status}`;
      throw new Error(`QQBot ASR request failed: ${message}`);
    }

    if (payload.code !== 0) {
      throw new Error(`QQBot ASR failed: ${payload.message ?? "unknown error"} (code=${payload.code})`);
    }

    const transcript = extractTranscript(payload);
    if (!transcript) {
      throw new Error("QQBot ASR returned empty transcript");
    }
    return transcript;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`QQBot ASR request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
