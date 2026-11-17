export const ROLES = ["patient", "admin"] as const;
export type AuthRole = (typeof ROLES)[number];
export type Role = AuthRole | "clerk";

export type Session = {
  id: number;
  role: AuthRole;
  name: string;
  title: string;
  email: string;
  profileImageUrl?: string;
  pid?: string;
};

export const SESSION_COOKIE = "sc_token";

export const ROLE_HOME: Record<AuthRole, string> = {
  patient: "/patient/book",
  admin: "/admin",
};

export function isRole(value: string | undefined | null): value is AuthRole {
  return value === "patient" || value === "admin";
}

export function roleFromPath(pathname: string): Role | null {
  if (pathname === "/patient" || pathname.startsWith("/patient/")) return "patient";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "admin";
  if (pathname === "/dentist" || pathname.startsWith("/dentist/")) return "admin";
  if (pathname === "/clerk" || pathname.startsWith("/clerk/")) return "admin";
  return null;
}

export function sessionFromUser(user: {
  id: number;
  role: string;
  fullName: string;
  title: string;
  email: string;
  patientCode?: string | null;
  profileImageUrl?: string;
}): Session | null {
  if (!isRole(user.role)) return null;
  return {
    id: user.id,
    role: user.role,
    name: user.fullName,
    title: user.role === "admin" ? "Dentist & Clinic Administrator" : user.title,
    email: user.email,
    ...(user.profileImageUrl ? { profileImageUrl: user.profileImageUrl } : {}),
    ...(user.patientCode ? { pid: user.patientCode } : {}),
  };
}

export async function updateAdminProfile(input: {
  fullName?: string;
  imageBase64?: string;
  contentType?: "image/jpeg" | "image/png" | "image/webp";
}) {
  const response = await fetch("/api/auth/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await response.json() as { fullName?: string; profileImageUrl?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message ?? "Could not update your profile.");
  return data;
}
