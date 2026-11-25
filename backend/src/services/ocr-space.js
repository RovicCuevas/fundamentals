import { HttpError } from "../lib/errors.js";

function providerConfig(config) {
  if (!config.ocrSpaceApiKey) {
    throw new HttpError(503, "identity_provider_not_configured", "Identity verification OCR is not configured.");
  }
}

function safeProviderDetail(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/(?:api[_ -]?key|api[_ -]?secret|apikey|secret)\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function fileMetadata(contentType) {
  if (contentType === "image/jpeg") return { filetype: "JPG", filename: "id-upload.jpg" };
  if (contentType === "image/png") return { filetype: "PNG", filename: "id-upload.png" };
  if (contentType === "image/webp") return { filetype: "WEBP", filename: "id-upload.webp" };
  return null;
}

export async function ocrIdImage(config, image) {
  providerConfig(config);
  const metadata = fileMetadata(image.contentType);
  if (!metadata) {
    throw new HttpError(422, "identity_image_invalid", "The government ID must be a JPEG, PNG, or WebP image.");
  }
  const form = new FormData();
  form.append("language", config.ocrSpaceLanguage);
  form.append("isOverlayRequired", "false");
  form.append("filetype", metadata.filetype);
  form.append("file", new Blob([image.data], { type: image.contentType }), metadata.filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ocrSpaceTimeoutMs);

  try {
    const response = await fetch(config.ocrSpaceApiUrl, {
      method: "POST",
      headers: { apikey: config.ocrSpaceApiKey },
      body: form,
      signal: controller.signal,
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new HttpError(502, "identity_provider_invalid_response", "The OCR provider returned an invalid response.");
    }
    if (!response.ok || result?.IsErroredOnProcessing === true || result?.ErrorMessage) {
      console.error("OCR.space identity request failed", { status: response.status });
      const detail = safeProviderDetail(
        Array.isArray(result?.ErrorMessage) ? result.ErrorMessage.join("; ") : result?.ErrorMessage,
      );
      throw new HttpError(
        502,
        "identity_provider_error",
        detail ? `OCR.space could not process the ID: ${detail}` : `OCR.space could not process the ID (HTTP ${response.status}).`,
      );
    }
    if (!result || !Array.isArray(result.ParsedResults)) {
      throw new HttpError(502, "identity_provider_invalid_response", "The OCR provider returned an invalid response.");
    }
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === "AbortError") {
      throw new HttpError(504, "identity_provider_timeout", "The OCR provider took too long to respond.");
    }
    throw new HttpError(502, "identity_provider_unavailable", "The OCR provider could not be reached.");
  } finally {
    clearTimeout(timer);
  }
}
