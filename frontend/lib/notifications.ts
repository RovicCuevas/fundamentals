import { readJsonResponse } from "@/lib/api-response";

export type NotificationItem = {
  id: number;
  appointmentId: number | null;
  channel: "email" | "sms";
  template: string;
  status: "sent" | "failed";
  createdAt: string;
  sentAt: string | null;
};

type NotificationsResponse = {
  notifications: NotificationItem[];
};

export async function fetchNotifications(): Promise<NotificationItem[]> {
  const response = await fetch("/api/notifications", { cache: "no-store" });
  const data = await readJsonResponse<NotificationsResponse & { error?: { message?: string } }>(response);
  if (!response.ok) throw new Error(data.error?.message ?? "Could not load notifications.");
  return data.notifications;
}
