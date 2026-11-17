"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { PageHeader } from "@/components/ui/empty-state";
import { MonthCalendar } from "@/components/ui/month-calendar";
import {
  formatAppointmentDate,
  formatAppointmentTime,
  getAppointments,
  getDayAvailability,
  createSlotHold,
  rescheduleAppointment,
  startPaymentCheckout,
  abandonPayment,
  submitAppointmentReview,
  updateAppointmentStatus,
  verifyAppointmentPayment,
  type Appointment,
} from "@/lib/appointments";

type AppointmentScope = "upcoming" | "past";

function clinicToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function monthOf(date: string) {
  return date.slice(0, 7);
}

function paymentTimeLeft(expiresAt?: string) {
  if (!expiresAt) return null;
  const minutes = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60_000));
  return minutes ? `${minutes} minute${minutes === 1 ? "" : "s"} left to pay` : "Payment window expired";
}

const appointmentMarkerColors: Record<Appointment["status"], string> = {
  pending: "#d97706",
  confirmed: "#0f9f75",
  declined: "#e11d48",
  cancelled: "#64748b",
  completed: "#0284c7",
  no_show: "#e11d48",
};

const statusStyles: Record<Appointment["status"], string> = {
  pending: "bg-warning/10 text-warning",
  confirmed: "bg-success/10 text-success",
  declined: "bg-danger/10 text-danger",
  cancelled: "bg-page text-muted",
  completed: "bg-tint-2 text-primary",
  no_show: "bg-danger/10 text-danger",
};

function statusLabel(status: Appointment["status"]) {
  return status.replace("_", " ");
}

function VisitReview({
  appointment,
  onSubmitted,
}: {
  appointment: Appointment;
  onSubmitted: (review: NonNullable<Appointment["patientReview"]>) => void;
}) {
  const [rating, setRating] = useState(0);
  const [hoveredRating, setHoveredRating] = useState(0);
  const [comment, setComment] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const displayedRating = hoveredRating || rating;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const review = await submitAppointmentReview(appointment.id, { rating, comment, isPublic });
      onSubmitted({
        rating: review.rating,
        comment: review.comment,
        isPublic: review.isPublic,
        createdAt: review.createdAt,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit your review.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 rounded-card border border-divider bg-page/50 p-4">
      <fieldset>
        <legend className="text-[13px] font-semibold text-heading">How satisfied were you with your visit with Dr. {appointment.dentist.name}?</legend>
        <div
          className="mt-2 flex items-center gap-1"
          role="radiogroup"
          aria-label="Rate your visit from 1 to 5 stars"
          onMouseLeave={() => setHoveredRating(0)}
        >
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={rating === value}
              aria-label={`${value} ${value === 1 ? "star" : "stars"}`}
              onClick={() => setRating(value)}
              onMouseEnter={() => setHoveredRating(value)}
              className="rounded p-1 text-amber-500 transition-transform hover:scale-110 focus-visible:outline-primary"
            >
              <Star
                className={`h-6 w-6 transition-colors ${displayedRating >= value ? "fill-current" : "text-amber-500/35"}`}
              />
            </button>
          ))}
          <span className="ml-2 min-w-[92px] text-[12px] text-muted" aria-live="polite">
            {displayedRating ? `${displayedRating}/5 selected` : "Select a rating"}
          </span>
        </div>
      </fieldset>
      <label className="mt-3 block text-[12px] font-medium text-heading">
        Comment (optional)
        <textarea
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          maxLength={1000}
          rows={3}
          placeholder="Share what went well about your visit."
          className="mt-1.5 w-full rounded-btn border border-border bg-white px-3 py-2.5 text-[13px] text-heading outline-none focus:border-primary"
        />
      </label>
      <label className="mt-2 flex items-start gap-2 text-[12px] text-muted">
        <input
          type="checkbox"
          checked={isPublic}
          onChange={(event) => setIsPublic(event.target.checked)}
          className="mt-0.5 accent-primary"
        />
        Show my comment publicly on the dentist directory. My name and appointment details will not be shown.
      </label>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
      <button
        type="submit"
        disabled={saving || rating === 0}
        className="mt-3 rounded-btn bg-primary px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-60"
      >
        {saving ? "Submitting..." : "Submit review"}
      </button>
    </form>
  );
}

export function PatientAppointments() {
  const [, refreshCountdown] = useState(0);
  const [scope, setScope] = useState<AppointmentScope>("upcoming");
  const [calendarMonth, setCalendarMonth] = useState(() => monthOf(clinicToday()));
  const [selectedDate, setSelectedDate] = useState(clinicToday);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loadedScope, setLoadedScope] = useState<AppointmentScope | null>(null);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [reschedulingId, setReschedulingId] = useState<number | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleTime, setRescheduleTime] = useState("");
  const [rescheduleSlots, setRescheduleSlots] = useState<Array<{ startTime: string; endTime: string; available: boolean }>>([]);
  const [rescheduleSlotsLoading, setRescheduleSlotsLoading] = useState(false);
  const [checkoutId, setCheckoutId] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [paymentNotice, setPaymentNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const timer = window.setInterval(() => refreshCountdown(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const loading = loadedScope !== scope;
  const calendarAppointments = loading ? [] : appointments;
  const calendarData = Object.fromEntries(
    calendarAppointments
      .filter((appointment) => monthOf(appointment.date) === calendarMonth)
      .reduce((days, appointment) => {
        const day = days.get(appointment.date) ?? { appointmentCount: 0, markers: [] };
        day.appointmentCount += 1;
        day.markers.push({
          color: appointmentMarkerColors[appointment.status],
          key: String(appointment.id),
          noShow: appointment.status === "no_show",
        });
        days.set(appointment.date, day);
        return days;
      }, new Map<string, { appointmentCount: number; markers: Array<{ color: string; key: string; noShow?: boolean }> }>()),
  );
  const visibleAppointments = selectedDate
    ? appointments.filter((appointment) => appointment.date === selectedDate)
    : appointments;

  useEffect(() => {
    const appointment = appointments.find((item) => item.id === reschedulingId);
    if (!appointment || !rescheduleDate) {
      return;
    }
    let cancelled = false;
    getDayAvailability(appointment.dentist.id, appointment.service.id, rescheduleDate)
      .then((result) => {
        if (cancelled) return;
        const slots = result.slots.filter((slot) => slot.available);
        if (rescheduleDate === appointment.date && !slots.some((slot) => slot.startTime === appointment.startTime)) {
          slots.push({ startTime: appointment.startTime, endTime: appointment.endTime, available: true });
          slots.sort((a, b) => a.startTime.localeCompare(b.startTime));
        }
        setRescheduleSlots(slots);
        setRescheduleTime((current) => slots.some((slot) => slot.startTime === current) ? current : "");
      })
      .catch((requestError: unknown) => {
        if (!cancelled) {
          setRescheduleSlots([]);
          setError(requestError instanceof Error ? requestError.message : "Could not load available reschedule times.");
        }
      })
      .finally(() => {
        if (!cancelled) setRescheduleSlotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appointments, reschedulingId, rescheduleDate]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await getAppointments(`scope=${scope}&pageSize=100&order=asc`);
        if (cancelled) return;
        setAppointments(result.items);
        setError("");
      } catch (requestError) {
        if (!cancelled) setError(requestError instanceof Error ? requestError.message : "Could not load your appointments.");
      } finally {
        if (!cancelled) setLoadedScope(scope);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, scope]);

  useEffect(() => {
    const refreshOnFocus = () => setRefreshKey((current) => current + 1);
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, []);

  useEffect(() => {
    const stream = new EventSource("/api/stream", { withCredentials: true });
    const onAppointmentUpdated = () => setRefreshKey((current) => current + 1);
    stream.addEventListener("appointment.updated", onAppointmentUpdated);
    return () => {
      stream.removeEventListener("appointment.updated", onAppointmentUpdated);
      stream.close();
    };
  }, []);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const paymentStatus = query.get("payment");
    const appointmentId = Number(query.get("appointmentId"));
    if (!paymentStatus || !Number.isSafeInteger(appointmentId) || appointmentId < 1) return;

    let cancelled = false;
    async function confirmPayment() {
      if (paymentStatus === "cancelled") {
        try {
          await abandonPayment(appointmentId);
          if (cancelled) return;
          setPaymentNotice("Checkout was cancelled and the appointment hold was released. You can book another time.");
        } catch (requestError) {
          if (!cancelled) {
            setPaymentNotice(requestError instanceof Error
              ? requestError.message
              : "Checkout was cancelled, but the appointment could not be released.");
          }
        }
      } else if (paymentStatus === "success") {
        try {
          const payment = await verifyAppointmentPayment(appointmentId);
          if (cancelled) return;
          setPaymentNotice(payment.status === "paid"
            ? "Deposit paid and booking confirmed. The remaining 50% balance is due over-the-counter upon procedure completion."
            : "Payment is still processing. Refresh this page in a moment to check its status.");
        } catch (requestError) {
          if (!cancelled) setPaymentNotice(requestError instanceof Error ? requestError.message : "Could not verify your payment.");
        }
      }
      if (!cancelled) {
        window.history.replaceState({}, "", window.location.pathname);
        setRefreshKey((current) => current + 1);
      }
    }
    void confirmPayment();
    return () => {
      cancelled = true;
    };
  }, []);

  async function cancelAppointment(id: number) {
    if (!window.confirm("Patient cancellations are free until 24 hours before the appointment. Continue?")) return;
    setUpdatingId(id);
    setError("");
    try {
      const updated = await updateAppointmentStatus(id, "cancelled");
      setAppointments((current) => current.map((appointment) => appointment.id === id ? updated : appointment));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not cancel this appointment.");
    } finally {
      setUpdatingId(null);
    }

  }

  async function submitReschedule(appointment: Appointment) {
    if (!rescheduleDate || !rescheduleTime) {
      setError("Choose a new date and time before rescheduling.");
      return;
    }
    setUpdatingId(appointment.id);
    setError("");
    try {
      const hold = await createSlotHold({
        serviceId: appointment.service.id,
        dentistId: appointment.dentist.id,
        date: rescheduleDate,
        startTime: rescheduleTime,
        ignoreApptId: appointment.id,
      });
      const updated = await rescheduleAppointment(appointment.id, {
        date: rescheduleDate,
        startTime: rescheduleTime,
        holdId: hold.id,
      });
      setAppointments((current) => current.map((item) => item.id === appointment.id ? updated : item));
      setReschedulingId(null);
      setRescheduleDate("");
      setRescheduleTime("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not reschedule this appointment.");
    } finally {
      setUpdatingId(null);
    }
  }

  async function payDeposit(id: number) {
    setCheckoutId(id);
    setError("");
    try {
      const appointment = appointments.find((item) => item.id === id);
      if (!appointment) throw new Error("Appointment could not be found. Refresh and try again.");
      const payment = await startPaymentCheckout(id, appointment.service.pricePhp);
      window.location.assign(payment.checkoutUrl);
    } catch (requestError) {
      let message = requestError instanceof Error ? requestError.message : "Could not open the payment checkout.";
      try {
        await abandonPayment(id);
        setAppointments((current) => current.map((item) => item.id === id ? { ...item, status: "cancelled", statusReason: "payment_checkout_failed" } : item));
      } catch (abandonError) {
        message = `${message} ${abandonError instanceof Error ? abandonError.message : "The pending appointment could not be released."}`;
      }
      setError(message);
      setCheckoutId(null);
    }
  }

  return (
    <div className="px-6 py-8 lg:px-8">
      <PageHeader
        title="My Appointments"
        description="View your scheduled visits and booking request status."
      />
      <div className="mb-5 flex gap-2" role="tablist" aria-label="Appointment history">
        {(["upcoming", "past"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={scope === item}
            onClick={() => {
              setLoadedScope(null);
              setScope(item);
              setSelectedDate("");
            }}
            className={`rounded-btn px-4 py-2 text-[13px] font-semibold capitalize ${
              scope === item ? "bg-primary text-white" : "bg-white text-slate shadow-card hover:bg-tint-2"
            }`}
          >
            {item}
          </button>
        ))}
      </div>

      {paymentNotice ? <p role="status" className="mb-4 rounded-lg bg-success/10 px-4 py-3 text-[13px] text-success">{paymentNotice}</p> : null}
      {error ? <p role="alert" className="mb-4 rounded-lg bg-danger/10 px-4 py-3 text-[13px] text-danger">{error}</p> : null}
      <section className="mb-5 rounded-card border border-border bg-white p-4 shadow-card sm:p-5">
        <div className="mb-3">
          <h2 className="font-heading text-[16px] font-semibold text-heading">Appointment calendar</h2>
          <p className="mt-1 text-[12px] text-muted">Select a date to see your scheduled visits. Dates with appointments show a count.</p>
        </div>
        <MonthCalendar
          month={calendarMonth}
          selectedDate={selectedDate}
          dayData={calendarData}
          mode="appointments"
          legendItems={[
            { color: appointmentMarkerColors.pending, label: "Pending" },
            { color: appointmentMarkerColors.confirmed, label: "Confirmed" },
            { color: appointmentMarkerColors.completed, label: "Completed" },
            { color: appointmentMarkerColors.cancelled, label: "Cancelled" },
            { color: appointmentMarkerColors.declined, label: "Declined / no-show" },
          ]}
          onMonthChange={(nextMonth) => {
            setCalendarMonth(nextMonth);
            setSelectedDate("");
          }}
          onSelectDate={setSelectedDate}
        />
      </section>
      {loading ? <p className="rounded-card border border-border bg-white p-6 text-[13px] text-muted">Loading appointments…</p> : null}
      {!loading && !error && appointments.length === 0 ? (
        <section className="rounded-card border border-dashed border-border bg-white p-8 text-center shadow-card">
          <h2 className="font-heading text-[17px] font-semibold text-heading">No {scope} appointments</h2>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted">
            {scope === "upcoming" ? "When you book a visit, it will appear here with its current confirmation status." : "Completed and previous appointments will appear here."}
          </p>
          {scope === "upcoming" ? (
            <Link href="/patient/book" className="mt-4 inline-flex rounded-btn bg-primary px-4 py-2.5 text-[13px] font-semibold text-white hover:bg-primary/90">
              Book an appointment
            </Link>
          ) : null}
        </section>
      ) : null}
      {!loading && appointments.length > 0 && selectedDate && visibleAppointments.length === 0 ? (
        <p className="mb-3 rounded-card border border-dashed border-border bg-white p-5 text-center text-[13px] text-muted">
          No {scope} appointments on {formatAppointmentDate(selectedDate)}. Choose a marked date to view a visit.
        </p>
      ) : null}

      <div className="grid gap-3">
        {!loading && visibleAppointments.map((appointment) => (
          <article key={appointment.id} className="rounded-card border border-border bg-white p-5 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{appointment.reference}</p>
                <h2 className="mt-1 font-heading text-[17px] font-semibold text-heading">{appointment.service.name}</h2>
              </div>
              <span className={`rounded-pill px-3 py-1 text-[11px] font-semibold capitalize ${statusStyles[appointment.status]}`}>
                {statusLabel(appointment.status)}
              </span>
            </div>
            <div className="mt-3 grid gap-1 text-[13px] text-slate sm:grid-cols-2">
              <p>{formatAppointmentDate(appointment.date)}</p>
              <p>{formatAppointmentTime(appointment.startTime)} – {formatAppointmentTime(appointment.endTime)}</p>
              <p>Dr. {appointment.dentist.name}</p>
              <p>{appointment.service.durationMin} minutes · {new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(appointment.service.pricePhp)}</p>
            </div>
            {appointment.payment.status !== "not_required" ? (
              <p className="mt-3 text-[12px] text-muted">
                Deposit: <span className="font-semibold text-heading">{appointment.payment.status === "paid" ? "Deposit Paid" : appointment.payment.status}</span>
                {appointment.payment.status === "paid" ? ` · ${new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(appointment.payment.depositAmountPhp)} received` : ""}
              </p>
            ) : null}
            {appointment.status === "pending" && appointment.payment.status !== "paid" ? (
              <p className="mt-1 text-[12px] font-semibold text-warning">{paymentTimeLeft(appointment.payment.expiresAt)}</p>
            ) : null}
            {appointment.payment.status === "paid" && appointment.status === "confirmed" ? (
              <div className="mt-4 rounded-card border border-success/30 bg-success-bg px-4 py-3">
                <p className="text-[13px] font-semibold text-success">Deposit Paid · Booking Confirmed</p>
                <p className="mt-1 text-[12px] leading-relaxed text-success">
                  Remaining 50% balance ({new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(
                    appointment.service.pricePhp - appointment.payment.depositAmountPhp,
                  )}) is to be paid over-the-counter upon procedure completion.
                </p>
              </div>
            ) : null}
            {appointment.statusReason ? <p className="mt-3 text-[12px] text-muted">Clinic note: {appointment.statusReason}</p> : null}
            {appointment.status === "completed" ? appointment.patientReview ? (
              <div className="mt-4 rounded-card border border-divider bg-page/50 p-4">
                <div className="flex items-center gap-2">
                  <span className="flex gap-0.5 text-amber-500" aria-label={`${appointment.patientReview.rating} out of 5 stars`}>
                    {Array.from({ length: 5 }, (_, index) => (
                      <Star key={index} className={`h-4 w-4 ${appointment.patientReview!.rating > index ? "fill-current" : ""}`} />
                    ))}
                  </span>
                  <span className="text-[12px] font-semibold text-heading">Your review was submitted</span>
                </div>
                {appointment.patientReview.comment ? (
                  <p className="mt-2 text-[13px] text-muted">{appointment.patientReview.comment}</p>
                ) : null}
                <p className="mt-2 text-[11px] text-muted">
                  {appointment.patientReview.isPublic ? "Your comment is public on the dentist directory." : "Your rating is included in the dentist’s average rating."}
                </p>
              </div>
            ) : (
              <VisitReview
                appointment={appointment}
                onSubmitted={(patientReview) => {
                  setAppointments((current) => current.map((item) =>
                    item.id === appointment.id ? { ...item, patientReview } : item,
                  ));
                }}
              />
            ) : null}
            {appointment.payment.refundStatus ? (
              <p className="mt-3 text-[12px] text-muted">
                Refund: <span className="font-semibold text-heading">{appointment.payment.refundStatus}</span>
                {appointment.payment.refundAmountPhp ? ` · ${new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(appointment.payment.refundAmountPhp)}` : ""}
              </p>
            ) : null}
            {["pending", "confirmed"].includes(appointment.status) && scope === "upcoming" ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {appointment.status === "pending" && appointment.payment.status !== "paid" ? (
                  <button
                    type="button"
                    disabled={checkoutId === appointment.id}
                    onClick={() => void payDeposit(appointment.id)}
                    className="rounded-btn bg-primary px-3 py-2 text-[12px] font-semibold text-white hover:bg-primary/90 disabled:opacity-60"
                  >
                    {checkoutId === appointment.id ? "Opening checkout…" : "Pay 50% deposit"}
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={updatingId === appointment.id}
                  onClick={() => {
                    setReschedulingId(appointment.id);
                    setRescheduleDate(appointment.date);
                    setRescheduleTime(appointment.startTime);
                    setRescheduleSlots([]);
                    setRescheduleSlotsLoading(true);
                  }}
                  className="rounded-btn border border-border px-3 py-2 text-[12px] font-semibold text-primary hover:bg-tint-2 disabled:opacity-60"
                >
                  Reschedule
                </button>
                <button
                  type="button"
                  disabled={updatingId === appointment.id}
                  onClick={() => void cancelAppointment(appointment.id)}
                  className="rounded-btn border border-border px-3 py-2 text-[12px] font-semibold text-danger hover:bg-danger/5 disabled:opacity-60"
                >
                  {updatingId === appointment.id ? "Cancelling…" : "Cancel appointment"}
                </button>
              </div>
            ) : null}
            {reschedulingId === appointment.id ? (
              <div className="mt-3 rounded-card border border-divider bg-page/50 p-4">
                <p className="text-[12px] text-muted">Free patient rescheduling is available until 24 hours before the appointment.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <label className="text-[12px] font-medium text-heading">
                    Date
                    <input
                      type="date"
                      value={rescheduleDate}
                      onChange={(event) => {
                        setRescheduleDate(event.target.value);
                        setRescheduleTime("");
                        setRescheduleSlots([]);
                        setRescheduleSlotsLoading(true);
                      }}
                      className="mt-1 block rounded-btn border border-border bg-white px-2 py-2 text-[12px]"
                    />
                  </label>
                  <label className="text-[12px] font-medium text-heading">
                    Time
                    <select
                      value={rescheduleTime}
                      onChange={(event) => setRescheduleTime(event.target.value)}
                      disabled={rescheduleSlotsLoading || rescheduleSlots.length === 0}
                      className="mt-1 block rounded-btn border border-border bg-white px-2 py-2 text-[12px] disabled:opacity-60"
                    >
                      <option value="">
                        {rescheduleSlotsLoading ? "Loading times..." : "Select a time"}
                      </option>
                      {rescheduleSlots.map((slot) => (
                        <option key={slot.startTime} value={slot.startTime}>
                          {formatAppointmentTime(slot.startTime)} – {formatAppointmentTime(slot.endTime)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {!rescheduleSlotsLoading && rescheduleDate && rescheduleSlots.length === 0 ? (
                  <p className="mt-2 text-[12px] text-muted">No one-hour slots are available on this date.</p>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <button type="button" disabled={updatingId === appointment.id} onClick={() => void submitReschedule(appointment)} className="rounded-btn bg-primary px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-60">
                    {updatingId === appointment.id ? "Saving..." : "Save new time"}
                  </button>
                  <button type="button" onClick={() => setReschedulingId(null)} className="rounded-btn border border-border px-3 py-2 text-[12px] font-semibold text-muted">
                    Keep current time
                  </button>
                </div>
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
