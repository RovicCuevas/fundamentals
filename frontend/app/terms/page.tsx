import Link from "next/link";
import { Logo } from "@/components/brand/logo";

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-2xl px-5 py-12">
      <Link href="/" className="inline-block">
        <Logo subtitle="Dental Clinic" />
      </Link>
      <h1 className="mt-8 font-heading text-[32px] font-bold">Terms of Care</h1>
      <p className="mt-4 rounded-btn border border-amber-300 bg-amber-50 p-3 text-[13px] font-semibold text-amber-900">
        DRAFT - review by a lawyer/privacy officer (Philippine Data Privacy Act RA 10173)
      </p>
      <div className="mt-6 space-y-5 text-[14px] leading-relaxed text-body">
        <p>Appointments may be booked online, as walk-ins, or through Messenger entries recorded by clinic staff.</p>
        <section>
          <h2 className="font-semibold text-heading">Online deposits and payment</h2>
          <p>Online bookings require a 50% deposit paid through PayMongo. The remaining balance is payable at the clinic unless the clinic confirms another arrangement. Do not send card details through chat.</p>
        </section>
        <section>
          <h2 className="font-semibold text-heading">Changes and cancellations</h2>
          <p>Please cancel or reschedule at least 24 hours before the appointment. Late cancellations and no-shows may forfeit the 50% deposit. Contact the clinic promptly if an emergency prevents attendance; any exception is subject to clinic review.</p>
        </section>
        <section>
          <h2 className="font-semibold text-heading">Care and records</h2>
          <p>Appointment availability is not a guarantee of a particular dentist or treatment outcome. Keep your account details accurate and use the service only for lawful purposes. Privacy handling is described in our Privacy Policy.</p>
        </section>
      </div>
    </div>
  );
}
