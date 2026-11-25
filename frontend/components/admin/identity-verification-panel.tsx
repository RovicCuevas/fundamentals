"use client";

import { useEffect, useRef, useState } from "react";
import * as faceapi from "face-api.js";
import { deleteIdentityVerification, getIdentityVerification, submitIdentityVerification, type IdentityVerification } from "@/lib/identity-verification";
import { readJsonResponse } from "@/lib/api-response";

const imageToBase64 = (file: File) =>
  new Promise<{ base64: string; dataUrl: string }>((resolve, reject) => {
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error("Images must be 5 MB or smaller."));
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      reject(new Error("Choose a JPEG, PNG, or WebP image."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      if (separator < 0) reject(new Error("Could not read the image."));
      else resolve({ base64: result.slice(separator + 1), dataUrl: result });
    };
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });

function statusLabel(status: IdentityVerification["status"]) {
  if (status === "verified") return "Verified";
  if (status === "rejected") return "Not verified";
  if (status === "pending") return "Processing";
  return "Not started";
}

export function IdentityVerificationPanel() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [verification, setVerification] = useState<IdentityVerification | null>(null);
  const [idImage, setIdImage] = useState("");
  const [selfie, setSelfie] = useState("");
  const [idPreview, setIdPreview] = useState("");
  const [selfiePreview, setSelfiePreview] = useState("");
  const [selfieDescriptor, setSelfieDescriptor] = useState<number[] | null>(null);
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setVideoReady(false);
    setCameraOpen(false);
  }

  useEffect(() => stopCamera, []);

  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!cameraOpen || !video || !stream) return;

    video.srcObject = stream;
    const playVideo = async () => {
      try {
        await video.play();
        setVideoReady(true);
      } catch {
        setVideoReady(false);
        setError("The camera preview could not start. Please close and reopen the camera.");
      }
    };
    const handleMetadata = () => void playVideo();
    video.addEventListener("loadedmetadata", handleMetadata, { once: true });
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) void playVideo();

    return () => {
      video.removeEventListener("loadedmetadata", handleMetadata);
      video.pause();
      video.srcObject = null;
    };
  }, [cameraOpen]);

  useEffect(() => {
    getIdentityVerification()
      .then(setVerification)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not load verification status."))
      .finally(() => setLoading(false));
  }, []);

  async function selectImage(
    file: File | undefined,
    setValue: (value: string) => void,
    setPreview: (value: string) => void,
    isSelfie = false,
  ) {
    if (!file) return;
    try {
      setError("");
      const image = await imageToBase64(file);
      setValue(image.base64);
      setPreview(image.dataUrl);
      if (isSelfie) {
        setSelfieDescriptor(null);
        await Promise.all([
          faceapi.nets.ssdMobilenetv1.loadFromUri("/models"),
          faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
          faceapi.nets.faceRecognitionNet.loadFromUri("/models"),
        ]);
        const element = await new Promise<HTMLImageElement>((resolve, reject) => {
          const loaded = new Image();
          loaded.onload = () => resolve(loaded);
          loaded.onerror = () => reject(new Error("Could not load the selfie."));
          loaded.src = image.dataUrl;
        });
        const detection = await faceapi
          .detectSingleFace(element, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
          .withFaceLandmarks()
          .withFaceDescriptor();
        if (!detection) throw new Error("No face detected in the selfie. Choose a clearer selfie.");
        setSelfieDescriptor(Array.from(detection.descriptor));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the image.");
    }
  }

  async function openCamera() {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Live camera capture is not supported by this browser. Please upload a selfie instead.");
      return;
    }
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      streamRef.current = stream;
      setVideoReady(false);
      setCameraOpen(true);
    } catch (cause) {
      setError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "Camera permission was denied. Please allow camera access or upload a selfie instead."
        : "Could not open the camera. Please upload a selfie instead.");
    }
  }

  async function captureSelfie() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setError("The camera is not ready yet. Please wait a moment and try again.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    const separator = dataUrl.indexOf(",");
    if (separator < 0) {
      setError("Could not capture the selfie. Please try again.");
      return;
    }
    setSelfie(dataUrl.slice(separator + 1));
    setSelfiePreview(dataUrl);
    setSelfieDescriptor(null);
    stopCamera();
    try {
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri("/models"),
        faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
        faceapi.nets.faceRecognitionNet.loadFromUri("/models"),
      ]);
      const detection = await faceapi
        .detectSingleFace(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!detection) throw new Error("No face detected in the captured selfie.");
      setSelfieDescriptor(Array.from(detection.descriptor));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare the captured selfie for face login.");
    }
  }

  async function enrollVerifiedSelfie(descriptor: number[]) {
    if (descriptor.length !== 128 || descriptor.some((value) => !Number.isFinite(value))) {
      throw new Error("A valid 128-float face descriptor could not be created.");
    }
    const response = await fetch("/api/auth/face-enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        consent: true,
        descriptor,
      }),
    });
    const data = await readJsonResponse<{ error?: { message?: string }; message?: string }>(response);
    if (!response.ok) {
      throw new Error(data.error?.message ?? data.message ?? "Could not enable face login.");
    }
    const statusResponse = await fetch("/api/auth/face-enroll/status", { cache: "no-store" });
    const status = await readJsonResponse<{ enrolled?: boolean; consentAt?: string | null } & { error?: { message?: string } }>(statusResponse);
    if (!statusResponse.ok || !status.enrolled) {
      throw new Error(status.error?.message ?? "Face login enrollment was not persisted.");
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!idImage || !selfie) {
      setError("Choose a government ID and capture a selfie.");
      return;
    }
    if (!selfieDescriptor) {
      setError("A face could not be prepared from your selfie. Choose a clearer selfie and try again.");
      return;
    }
    if (!consent) {
      setError("Consent is required before identity verification.");
      return;
    }
    setSaving(true);
    setError("");
    setProgress("Scanning ID...");
    const progressTimer = window.setTimeout(() => setProgress("Comparing faces..."), 1800);
    try {
      const identity = await submitIdentityVerification({ idImageBase64: idImage, selfieImageBase64: selfie, consent: true });
      if (identity.status !== "verified") {
        setVerification(identity);
        throw new Error(identity.failureReason ?? "Identity verification was not successful.");
      }
      setProgress("Verification complete. Enabling face login...");
      try {
        await enrollVerifiedSelfie(selfieDescriptor);
      } catch (cause) {
        setVerification(identity);
        throw new Error(
          cause instanceof Error
            ? `Identity verified, but face login enrollment failed: ${cause.message}`
            : "Identity verified, but face login enrollment failed.",
        );
      }
      setVerification(identity);
      setProgress("Identity and face login are ready.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit identity verification.");
      setProgress("");
    } finally {
      window.clearTimeout(progressTimer);
      setSaving(false);
    }
  }

  async function deleteVerification() {
    setSaving(true);
    setError("");
    try {
      setVerification(await deleteIdentityVerification());
      setIdImage("");
      setSelfie("");
      setIdPreview("");
      setSelfiePreview("");
      setSelfieDescriptor(null);
      setConsent(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete verification data.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-6 rounded-panel border border-divider bg-white p-5 shadow-card sm:p-6" aria-labelledby="identity-verification-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="identity-verification-title" className="font-heading text-[19px] font-bold text-heading">Identity verification</h2>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-muted">
            Verify your dentist or administrator account with a government ID and selfie. The ID is read by OCR.space and both images are compared by Face++; raw images are not saved by SmartCare.
          </p>
        </div>
        {!loading && verification ? <span className="rounded-pill bg-tint-2 px-2.5 py-1 text-[11px] font-semibold text-primary">{statusLabel(verification.status)}</span> : null}
      </div>

      {verification?.status === "verified" ? (
        <p className="mt-4 text-[13px] text-success">Your identity was verified successfully.</p>
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[12px] font-medium text-heading">
              Government ID
              <input className="mt-1 block w-full text-[12px] text-muted" type="file" accept="image/jpeg,image/png,image/webp" disabled={saving} onChange={(event) => void selectImage(event.target.files?.[0], setIdImage, setIdPreview)} />
              {idPreview ? <img src={idPreview} alt="Government ID preview" className="mt-2 h-24 w-36 rounded border border-divider object-cover" /> : null}
            </label>
            <label className="text-[12px] font-medium text-heading">
              Selfie
              <input className="mt-1 block w-full text-[12px] text-muted" type="file" accept="image/jpeg,image/png,image/webp" capture="user" disabled={saving} onChange={(event) => void selectImage(event.target.files?.[0], setSelfie, setSelfiePreview, true)} />
              {selfiePreview ? <img src={selfiePreview} alt="Selfie preview" className="mt-2 h-24 w-24 rounded border border-divider object-cover" /> : null}
            </label>
          </div>
          <div className="rounded border border-divider bg-page/50 p-3">
            <p className="text-[12px] font-medium text-heading">Live selfie capture (optional)</p>
            {cameraOpen ? (
              <div className="mt-2 flex flex-wrap items-end gap-3">
                <video ref={videoRef} muted playsInline className="h-40 w-32 rounded border border-divider bg-black object-cover" />
                <div className="flex gap-2">
                  <button type="button" onClick={captureSelfie} disabled={!videoReady} className="rounded-btn bg-primary px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-60">Capture Selfie</button>
                  <button type="button" onClick={stopCamera} className="rounded-btn border border-border px-3 py-2 text-[12px] font-semibold text-primary">Close camera</button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => void openCamera()} disabled={saving} className="mt-2 rounded-btn border border-border px-3 py-2 text-[12px] font-semibold text-primary disabled:opacity-60">
                Open camera
              </button>
            )}
          </div>
          <label className="flex items-start gap-2 text-[12px] text-muted">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>I consent to OCR.space reading my government ID and Face++ comparing my ID photo with my selfie for identity verification.</span>
          </label>
          <button type="submit" disabled={saving || loading} className="rounded-btn bg-primary px-4 py-2.5 text-[12px] font-semibold text-white disabled:opacity-60">
            {saving ? progress || "Verifying..." : "Verify identity"}
          </button>
          {progress ? <p className="text-[12px] text-muted" aria-live="polite">{progress}</p> : null}
        </form>
      )}
      {verification?.status === "rejected" && verification.failureReason ? <p className="mt-3 text-[12px] text-danger">{verification.failureReason}</p> : null}
      {verification && verification.status !== "not_started" ? (
        <button type="button" disabled={saving} onClick={() => void deleteVerification()} className="mt-3 rounded-btn border border-danger/30 px-4 py-2.5 text-[12px] font-semibold text-danger disabled:opacity-60">
          Delete verification data
        </button>
      ) : null}
      {error ? <div role="alert" className="mt-3 rounded border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] font-medium text-danger">{error}</div> : null}
    </section>
  );
}
