"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, RotateCcw, Save, Stethoscope, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/ui/empty-state";
import { IdentityVerificationPanel } from "@/components/admin/identity-verification-panel";
import { useAuth } from "@/components/auth/auth-provider";
import {
  createClinicDentist,
  createClinicService,
  deleteClinicDentist,
  deleteClinicService,
  getDentists,
  getServices,
  subscribeToClinicCatalog,
  updateClinicDentist,
  updateClinicService,
  type Dentist,
  type Service,
} from "@/lib/appointments";

const inputClass =
  "mt-1 w-full rounded-btn border border-border bg-white px-3 py-2.5 text-[13px] text-heading outline-none focus:border-primary focus:ring-2 focus:ring-primary/15";
const initialService = { name: "", category: "", description: "", pricePhp: "", durationMin: "60", prepGuidelines: "" };
const initialDentist = {
  fullName: "",
  specialty: "",
  bio: "",
  imageBase64: "",
  contentType: "" as "" | "image/jpeg" | "image/png" | "image/webp",
};
const defaultProfiles = [
  { value: "mint", label: "Mint dentist", background: "#dff5ef", foreground: "#13796b" },
  { value: "blue", label: "Blue dentist", background: "#e1efff", foreground: "#2563a8" },
  { value: "lavender", label: "Lavender dentist", background: "#eee8ff", foreground: "#6d4bb3" },
] as const;
type DefaultProfile = (typeof defaultProfiles)[number]["value"];

export default function ClinicSetupPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [dentists, setDentists] = useState<Dentist[]>([]);
  const [serviceForm, setServiceForm] = useState(initialService);
  const [dentistForm, setDentistForm] = useState(initialDentist);
  const [editingServiceId, setEditingServiceId] = useState<number | null>(null);
  const [editingDentistId, setEditingDentistId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingService, setSavingService] = useState(false);
  const [savingDentist, setSavingDentist] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [defaultProfile, setDefaultProfile] = useState<DefaultProfile | "">("");
  const [imagePreviewUrl, setImagePreviewUrl] = useState("");
  const { refreshSession } = useAuth();

  function clearDentistImage() {
    setDentistForm({ ...dentistForm, imageBase64: "", contentType: "" });
    setDefaultProfile("");
    setImagePreviewUrl("");
  }

  function imageToPayload(image: HTMLImageElement, sourceUrl: string) {
    const size = Math.min(image.naturalWidth, image.naturalHeight);
    if (size < 200) {
      URL.revokeObjectURL(sourceUrl);
      throw new Error("Images must be at least 200 by 200 pixels.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    if (!context) {
      URL.revokeObjectURL(sourceUrl);
      throw new Error("Could not prepare the image.");
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      image,
      (image.naturalWidth - size) / 2,
      (image.naturalHeight - size) / 2,
      size,
      size,
      0,
      0,
      512,
      512,
    );
    URL.revokeObjectURL(sourceUrl);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
    return {
      imageBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      contentType: "image/jpeg" as const,
      previewUrl: dataUrl,
    };
  }

  function readDentistImage(file: File) {
    if (file.size > 5 * 1024 * 1024) {
      throw new Error("Images must be 5 MB or smaller.");
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      throw new Error("Choose a JPEG, PNG, or WebP image.");
    }
    return new Promise<{ imageBase64: string; contentType: "image/jpeg"; previewUrl: string }>((resolve, reject) => {
      const sourceUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        try {
          resolve(imageToPayload(image, sourceUrl));
        } catch (cause) {
          reject(cause);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(sourceUrl);
        reject(new Error("Could not read the image."));
      };
      image.src = sourceUrl;
    });
  }

  function createDefaultProfile(name: string, profile: DefaultProfile) {
    const selected = defaultProfiles.find((item) => item.value === profile);
    if (!selected) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the default profile.");
    context.fillStyle = selected.background;
    context.fillRect(0, 0, 512, 512);
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.arc(256, 210, 105, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = selected.foreground;
    context.beginPath();
    context.arc(256, 185, 48, 0, Math.PI * 2);
    context.fill();
    context.fillRect(174, 280, 164, 120);
    context.fillStyle = "#ffffff";
    context.font = "700 54px Arial";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(name.trim().charAt(0).toUpperCase() || "D", 256, 185);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
    return {
      imageBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      contentType: "image/jpeg" as const,
      previewUrl: dataUrl,
    };
  }

  const refreshCatalog = useCallback(async () => {
    const [serviceResult, dentistResult] = await Promise.all([
      getServices(true),
      getDentists(true),
    ]);
    setServices(serviceResult.items);
    setDentists(dentistResult.items);
  }, []);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const [serviceResult, dentistResult] = await Promise.all([
          getServices(true),
          getDentists(true),
        ]);
        if (!mounted) return;
        setServices(serviceResult.items);
        setDentists(dentistResult.items);
        setError("");
      } catch (cause) {
        if (mounted) setError(cause instanceof Error ? cause.message : "Could not load clinic settings.");
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void load();
    const unsubscribe = subscribeToClinicCatalog(() => {
      void refreshCatalog().catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not refresh clinic settings.");
      });
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [refreshCatalog]);

  function clearServiceForm() {
    setServiceForm(initialService);
    setEditingServiceId(null);
  }

  function clearDentistForm() {
    setDentistForm(initialDentist);
    setEditingDentistId(null);
    setDefaultProfile("");
    setImagePreviewUrl("");
  }

  async function saveService(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingService(true);
    setError("");
    setNotice("");
    try {
      const data = {
        name: serviceForm.name,
        category: serviceForm.category,
        description: serviceForm.description,
        pricePhp: Number(serviceForm.pricePhp),
        durationMin: Number(serviceForm.durationMin),
        prepGuidelines: serviceForm.prepGuidelines,
      };
      if (editingServiceId) await updateClinicService(editingServiceId, data);
      else await createClinicService(data);
      await refreshCatalog();
      clearServiceForm();
      setNotice(editingServiceId ? "Service updated." : "Service added.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this service.");
    } finally {
      setSavingService(false);
    }
  }

  async function saveDentist(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingDentist(true);
    setError("");
    setNotice("");
    try {
      const selectedImage = defaultProfile
        ? createDefaultProfile(dentistForm.fullName, defaultProfile)
        : dentistForm.imageBase64
          ? { imageBase64: dentistForm.imageBase64, contentType: dentistForm.contentType }
          : null;
      const text = {
        fullName: dentistForm.fullName,
        specialty: dentistForm.specialty,
        bio: dentistForm.bio,
      };
      const data = selectedImage?.imageBase64 && selectedImage.contentType
        ? { ...text, imageBase64: selectedImage.imageBase64, contentType: selectedImage.contentType }
        : text;
      if (editingDentistId) await updateClinicDentist(editingDentistId, data);
      else await createClinicDentist(data);
      await refreshCatalog();
      await refreshSession();
      clearDentistForm();
      setNotice(editingDentistId ? "Dentist updated." : "Dentist added.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this dentist.");
    } finally {
      setSavingDentist(false);
    }
  }

  async function archiveService(service: Service) {
    setError("");
    setNotice("");
    try {
      await deleteClinicService(service.id);
      await refreshCatalog();
      setNotice(`${service.name} removed from booking.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove this service.");
    }
  }

  async function archiveDentist(dentist: Dentist) {
    setError("");
    setNotice("");
    try {
      await deleteClinicDentist(dentist.id);
      await refreshCatalog();
      setNotice(`${dentist.name} removed from booking.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove this dentist.");
    }
  }

  async function restoreService(service: Service) {
    setError("");
    try {
      await updateClinicService(service.id, { active: true });
      await refreshCatalog();
      setNotice(`${service.name} is available for booking again.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this service.");
    }
  }

  async function restoreDentist(dentist: Dentist) {
    setError("");
    try {
      await updateClinicDentist(dentist.id, { active: true });
      await refreshCatalog();
      setNotice(`${dentist.name} is available for booking again.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this dentist.");
    }
  }

  return (
    <div className="mx-auto max-w-[1200px] px-5 py-8 sm:px-8">
      <PageHeader
        kicker="Admin tools"
        title="Clinic Setup"
        description="Manage the services and dentist directory patients see when booking. Changes are shared with open booking pages."
      />

      {error ? <p role="alert" className="mb-4 rounded-btn border border-danger/30 bg-danger-bg px-4 py-3 text-[13px] text-danger">{error}</p> : null}
      {notice ? <p role="status" className="mb-4 rounded-btn border border-success/30 bg-success-bg px-4 py-3 text-[13px] text-success">{notice}</p> : null}

      <IdentityVerificationPanel />

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-panel border border-divider bg-white p-5 shadow-card sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-heading text-[19px] font-bold text-heading">Services</h2>
              <p className="mt-1 text-[12px] text-muted">Update procedure names, prices, and booking details.</p>
            </div>
            <span className="rounded-pill bg-tint-2 px-2.5 py-1 text-[11px] font-semibold text-primary">{services.filter((item) => item.active !== false).length} active</span>
          </div>

          <form onSubmit={saveService} className="space-y-3 rounded-card border border-divider bg-page/40 p-4">
            <h3 className="text-[13px] font-semibold text-heading">{editingServiceId ? "Edit service" : "Add a service"}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[12px] font-medium text-heading">Service name
                <input className={inputClass} required minLength={2} maxLength={100} value={serviceForm.name} onChange={(event) => setServiceForm({ ...serviceForm, name: event.target.value })} />
              </label>
              <label className="text-[12px] font-medium text-heading">Category
                <input className={inputClass} required minLength={2} maxLength={60} value={serviceForm.category} onChange={(event) => setServiceForm({ ...serviceForm, category: event.target.value })} />
              </label>
              <label className="text-[12px] font-medium text-heading">Price (PHP)
                <input className={inputClass} type="number" min="0" max="1000000" step="1" required value={serviceForm.pricePhp} onChange={(event) => setServiceForm({ ...serviceForm, pricePhp: event.target.value })} />
              </label>
              <label className="text-[12px] font-medium text-heading">Duration (minutes)
                <input className={inputClass} type="number" min="5" max="480" step="1" required value={serviceForm.durationMin} onChange={(event) => setServiceForm({ ...serviceForm, durationMin: event.target.value })} />
              </label>
            </div>
            <label className="block text-[12px] font-medium text-heading">Description
              <textarea className={inputClass} rows={2} maxLength={1000} value={serviceForm.description} onChange={(event) => setServiceForm({ ...serviceForm, description: event.target.value })} />
            </label>
            <label className="block text-[12px] font-medium text-heading">Preparation guidelines
              <textarea className={inputClass} rows={2} maxLength={2000} value={serviceForm.prepGuidelines} onChange={(event) => setServiceForm({ ...serviceForm, prepGuidelines: event.target.value })} />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={savingService} className="inline-flex items-center gap-2 rounded-btn bg-primary px-4 py-2.5 text-[12px] font-semibold text-white disabled:opacity-60">
                <Save size={15} /> {savingService ? "Saving..." : editingServiceId ? "Save service" : "Add service"}
              </button>
              {editingServiceId ? <button type="button" onClick={clearServiceForm} className="inline-flex items-center gap-2 rounded-btn border border-border px-4 py-2.5 text-[12px] font-semibold text-heading"><X size={15} /> Cancel</button> : null}
            </div>
          </form>

          <div className="mt-5 divide-y divide-divider">
            {loading ? <p className="py-5 text-[13px] text-muted">Loading services...</p> : services.length ? services.map((service) => (
              <article key={service.id} className={`flex items-start justify-between gap-3 py-4 ${service.active === false ? "opacity-60" : ""}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[13px] font-semibold text-heading">{service.name}</h3>
                    <span className="rounded-pill bg-tint-1 px-2 py-0.5 text-[10px] font-medium text-muted">{service.category}</span>
                    {service.active === false ? <span className="text-[10px] font-semibold text-danger">Inactive</span> : null}
                  </div>
                  <p className="mt-1 text-[12px] text-muted">₱{service.pricePhp.toLocaleString("en-PH")} · {service.durationMin} min</p>
                  {service.description ? <p className="mt-1 text-[12px] text-muted">{service.description}</p> : null}
                </div>
                <div className="flex shrink-0 gap-1">
                  {service.active === false ? <button type="button" onClick={() => void restoreService(service)} className="rounded-btn p-2 text-primary hover:bg-tint-2" aria-label={`Restore ${service.name}`} title="Restore"><RotateCcw size={16} /></button> : <>
                    <button type="button" onClick={() => { setServiceForm({ name: service.name, category: service.category, description: service.description, pricePhp: String(service.pricePhp), durationMin: String(service.durationMin), prepGuidelines: service.prepGuidelines }); setEditingServiceId(service.id); }} className="rounded-btn p-2 text-slate hover:bg-page" aria-label={`Edit ${service.name}`} title="Edit"><Pencil size={16} /></button>
                    <button type="button" onClick={() => void archiveService(service)} className="rounded-btn p-2 text-danger hover:bg-danger-bg" aria-label={`Remove ${service.name}`} title="Remove"><Trash2 size={16} /></button>
                  </>}
                </div>
              </article>
            )) : <p className="py-5 text-[13px] text-muted">No services are set up yet.</p>}
          </div>
        </section>

        <section className="rounded-panel border border-divider bg-white p-5 shadow-card sm:p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-heading text-[19px] font-bold text-heading">Dentist directory</h2>
              <p className="mt-1 text-[12px] text-muted">These dentists appear as booking choices. They are managed by the admin account.</p>
            </div>
            <span className="rounded-pill bg-tint-2 px-2.5 py-1 text-[11px] font-semibold text-primary">{dentists.filter((item) => item.active !== false).length} active</span>
          </div>

          <form onSubmit={saveDentist} className="space-y-3 rounded-card border border-divider bg-page/40 p-4">
            <h3 className="text-[13px] font-semibold text-heading">{editingDentistId ? "Edit dentist" : "Add a dentist"}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[12px] font-medium text-heading">Dentist name
                <input className={inputClass} required minLength={2} maxLength={120} value={dentistForm.fullName} onChange={(event) => setDentistForm({ ...dentistForm, fullName: event.target.value })} />
              </label>
              <label className="text-[12px] font-medium text-heading">Specialty
                <input className={inputClass} maxLength={100} value={dentistForm.specialty} onChange={(event) => setDentistForm({ ...dentistForm, specialty: event.target.value })} placeholder="General Dentistry" />
              </label>
            </div>
            <label className="block text-[12px] font-medium text-heading">About the dentist
              <textarea className={inputClass} rows={3} maxLength={1000} value={dentistForm.bio} onChange={(event) => setDentistForm({ ...dentistForm, bio: event.target.value })} />
            </label>
            <label className="block text-[12px] font-medium text-heading">Profile picture
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className={inputClass}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void readDentistImage(file).then((image) => {
                    setDentistForm({ ...dentistForm, imageBase64: image.imageBase64, contentType: image.contentType });
                    setDefaultProfile("");
                    setImagePreviewUrl(image.previewUrl);
                    setError("");
                  }).catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : "Could not read the image.");
                  });
                }}
              />
            </label>
            <label className="block text-[12px] font-medium text-heading">Default profile
            <select
              className={inputClass}
              value={defaultProfile}
              onChange={(event) => {
                const value = event.target.value as DefaultProfile | "";
                setDefaultProfile(value);
                if (!value) {
                  clearDentistImage();
                  return;
                }
                const image = createDefaultProfile(dentistForm.fullName, value);
                if (image) {
                  setDentistForm({ ...dentistForm, imageBase64: image.imageBase64, contentType: image.contentType });
                  setImagePreviewUrl(image.previewUrl);
                }
              }}
            >
              <option value="">Use uploaded picture or icon fallback</option>
              {defaultProfiles.map((profile) => <option key={profile.value} value={profile.value}>{profile.label}</option>)}
            </select>
            <span className="mt-1 block text-[11px] text-muted">Choosing a default replaces the uploaded picture for this dentist.</span>
            </label>
            {imagePreviewUrl ? (
            <div className="flex items-center gap-3 rounded-btn border border-divider bg-white p-2">
              <img src={imagePreviewUrl} alt="Profile picture preview" className="h-16 w-16 rounded-full object-cover" />
              <button type="button" onClick={clearDentistImage} className="text-[12px] font-semibold text-danger hover:underline">Remove picture</button>
            </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={savingDentist} className="inline-flex items-center gap-2 rounded-btn bg-primary px-4 py-2.5 text-[12px] font-semibold text-white disabled:opacity-60">
                <Plus size={15} /> {savingDentist ? "Saving..." : editingDentistId ? "Save dentist" : "Add dentist"}
              </button>
              {editingDentistId ? <button type="button" onClick={clearDentistForm} className="inline-flex items-center gap-2 rounded-btn border border-border px-4 py-2.5 text-[12px] font-semibold text-heading"><X size={15} /> Cancel</button> : null}
            </div>
          </form>

          <div className="mt-5 divide-y divide-divider">
            {loading ? <p className="py-5 text-[13px] text-muted">Loading dentists...</p> : dentists.length ? dentists.map((dentist) => (
              <article key={dentist.id} className={`flex items-start justify-between gap-3 py-4 ${dentist.active === false ? "opacity-60" : ""}`}>
                <div className="flex min-w-0 gap-3">
                  {dentist.profileImageUrl ? <img src={dentist.profileImageUrl} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" /> : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tint-2 text-primary"><Stethoscope size={17} /></span>}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[13px] font-semibold text-heading">{dentist.name}</h3>
                      {dentist.active === false ? <span className="text-[10px] font-semibold text-danger">Inactive</span> : null}
                    </div>
                    <p className="mt-1 text-[12px] text-muted">{dentist.specialty || "General Dentistry"}</p>
                    {dentist.bio ? <p className="mt-1 text-[12px] text-muted">{dentist.bio}</p> : null}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  {dentist.active === false ? <button type="button" onClick={() => void restoreDentist(dentist)} className="rounded-btn p-2 text-primary hover:bg-tint-2" aria-label={`Restore ${dentist.name}`} title="Restore"><RotateCcw size={16} /></button> : <>
                    <button type="button" onClick={() => { setDentistForm({ fullName: dentist.name, specialty: dentist.specialty, bio: dentist.bio ?? "", imageBase64: "", contentType: "" }); setDefaultProfile(""); setImagePreviewUrl(dentist.profileImageUrl ?? ""); setEditingDentistId(dentist.id); }} className="rounded-btn p-2 text-slate hover:bg-page" aria-label={`Edit ${dentist.name}`} title="Edit"><Pencil size={16} /></button>
                    <button type="button" onClick={() => void archiveDentist(dentist)} className="rounded-btn p-2 text-danger hover:bg-danger-bg" aria-label={`Remove ${dentist.name}`} title="Remove"><Trash2 size={16} /></button>
                  </>}
                </div>
              </article>
            )) : <p className="py-5 text-[13px] text-muted">No dentists are set up yet.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
