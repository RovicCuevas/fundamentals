import { HttpError } from "../lib/errors.js";

function providerConfig(config) {
  if (!config.facePlusPlusApiKey || !config.facePlusPlusApiSecret) {
    throw new HttpError(503, "identity_provider_not_configured", "Identity verification is not configured.");
  }
  return config;
}

function safeProviderDetail(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/(?:api[_ -]?key|api[_ -]?secret|apikey|secret)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function appendImage(form, field, image) {
  form.append(field, new Blob([image.data], { type: image.contentType }), `${field}.jpg`);
}

async function request(config, path, form) {
  providerConfig(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.facePlusPlusTimeoutMs);
  form.append("api_key", config.facePlusPlusApiKey);
  form.append("api_secret", config.facePlusPlusApiSecret);
  try {
    const response = await fetch(new URL(path, config.facePlusPlusBaseUrl), {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new HttpError(502, "identity_provider_invalid_response", "The identity provider returned an invalid response.");
    }
    if (!response.ok || result?.error_message) {
      console.error("Face++ identity request failed", {
        status: response.status,
        errorCode: typeof result?.error_code === "string" ? result.error_code : undefined,
      });
      const code = typeof result?.error_code === "string" ? ` (${result.error_code})` : "";
      const detail = safeProviderDetail(result?.error_message);
      throw new HttpError(
        502,
        "identity_provider_error",
        detail ? `Face++ could not compare the images${code}: ${detail}` : `Face++ could not compare the images${code} (HTTP ${response.status}).`,
      );
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new HttpError(502, "identity_provider_invalid_response", "The identity provider returned an invalid response.");
    }
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === "AbortError") {
      throw new HttpError(504, "identity_provider_timeout", "The identity provider took too long to respond.");
    }
    throw new HttpError(502, "identity_provider_unavailable", "The identity provider could not be reached.");
  } finally {
    clearTimeout(timer);
  }
}

export function compareFaces(config, firstImage, secondImage) {
  const form = new FormData();
  appendImage(form, "image_file1", firstImage);
  appendImage(form, "image_file2", secondImage);
  return request(config, config.facePlusPlusComparePath, form);
}
