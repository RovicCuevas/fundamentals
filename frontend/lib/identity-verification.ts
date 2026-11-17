import { readJsonResponse } from "./api-response";

export type IdentityVerification = {
  status: "not_started" | "pending" | "verified" | "rejected";
  consentAt?: string | null;
  idFullName?: string | null;
  idBirthDate?: string | null;
  idNumberLast4?: string | null;
  idExpiryDate?: string | null;
  faceMatchScore?: number | null;
  failureReason?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const data = await readJsonResponse<T & { error?: { message?: string } }>(response);
  if (!response.ok) throw new Error(data.error?.message ?? "Identity verification failed.");
  return data;
}

export function getIdentityVerification() {
  return request<IdentityVerification>("/api/identity-verification");
}

export function submitIdentityVerification(input: {
  idImageBase64: string;
  selfieImageBase64: string;
  consent: true;
}) {
  return request<IdentityVerification>("/api/identity-verification", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function deleteIdentityVerification() {
  return request<IdentityVerification>("/api/identity-verification", { method: "DELETE" });
}
