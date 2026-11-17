import { PageHeader } from "@/components/ui/empty-state";

export default function HelpPage() {
  return (
    <div className="px-6 py-8 lg:px-8">
      <PageHeader title="Help & Support" description="Reach the SmartCare front desk." />
      <div className="max-w-lg rounded-card border border-divider bg-white p-6 shadow-card">
        <p className="text-[14px] leading-relaxed text-body">
          For appointment changes, call <span className="font-semibold text-heading">0947-191-4201</span> or email{" "}
          <span className="font-semibold text-heading">desa_dentist@yahoo.com.ph</span>.
        </p>
        <p className="mt-3 text-[13px] text-muted">
          Please cancel or reschedule at least 24 hours before your appointment. Online bookings require a 50%
          PayMongo deposit; late cancellations and no-shows may forfeit the deposit. The remaining balance is
          payable at the clinic.
        </p>
      </div>
    </div>
  );
}
