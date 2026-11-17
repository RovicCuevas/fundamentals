import Link from "next/link";
import { Logo } from "@/components/brand/logo";

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl px-5 py-12">
      <Link href="/" className="inline-block">
        <Logo subtitle="Dental Clinic" />
      </Link>
      <h1 className="mt-8 font-heading text-[32px] font-bold">Privacy Policy</h1>
      <p className="mt-4 rounded-btn border border-amber-300 bg-amber-50 p-3 text-[13px] font-semibold text-amber-900">
        DRAFT - review by a lawyer/privacy officer (Philippine Data Privacy Act RA 10173)
      </p>
      <div className="mt-6 space-y-5 text-[14px] leading-relaxed text-body">
        <p>
          Petil Dental Clinic, #307 Batangas - Quezon Road, Rosario, Batangas, describes in this draft how it
          handles patient information. We do not sell patient information.
        </p>
        <section>
          <h2 className="font-semibold text-heading">Information we collect</h2>
          <p>We may collect identity and contact details, appointment and visit history, health notes, messages and chat content, payment and transaction details, optional face-login data (an encrypted face descriptor), and identity-verification data for dentist and administrator accounts.</p>
        </section>
        <section>
          <h2 className="font-semibold text-heading">Why we use it</h2>
          <p>We use this information to create and manage your account, schedule and provide dental care, communicate with you, process the 50% online deposit, maintain records, protect the service, and meet legal obligations. Face-login data and identity-verification data are used only when you separately choose and consent to those checks.</p>
        </section>
        <section>
          <h2 className="font-semibold text-heading">Who receives it</h2>
          <p>Information is shared only as needed with authorized clinic staff and service providers that support the service, including PayMongo for online deposits and our hosting/database providers, including Supabase. Providers are expected to protect the information they process for the clinic.</p>
        </section>
        <section>
          <h2 className="font-semibold text-heading">Retention and your rights</h2>
          <p>We retain information only for as long as reasonably needed for care, records, legal obligations, dispute resolution, and security, then securely delete or anonymize it when practical. Subject to applicable law, you may request access, correction, deletion, or information about processing, and withdraw consent for optional processing. Withdrawal does not affect processing already performed lawfully and may limit services that require the information.</p>
        </section>
        <section>
          <h2 className="font-semibold text-heading">Face-login consent</h2>
          <p>Face login is optional. You can withdraw that consent and delete the stored face descriptor from your account or by contacting us. We will not require face data to provide ordinary password-based access.</p>
          <p>Identity verification is optional for dentist and administrator accounts. Government-ID and selfie images are sent to Face++ for OCR and face comparison, but SmartCare does not retain the raw images or complete OCR response. We retain only the selected verification fields, the last four characters of the ID number, the comparison score, consent record, and verification result.</p>
        </section>
        <section>
          <h2 className="font-semibold text-heading">Questions or a breach report</h2>
          <p>For privacy requests or suspected breaches, contact the clinic at 0947-191-4201 or desa_dentist@yahoo.com.ph. This draft uses that clinic contact as the data-protection contact pending appointment of a named privacy officer.</p>
        </section>
      </div>
    </div>
  );
}
