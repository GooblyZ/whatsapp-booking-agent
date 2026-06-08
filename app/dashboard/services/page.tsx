export const dynamic = "force-dynamic";

import { getDefaultBusinessId } from "@/lib/config";
import { getServices, getServiceCategories } from "@/lib/services/catalog";
import {
  createServiceAction,
  updateServiceAction,
  toggleServiceActiveAction,
} from "./actions";
import { SaveBanner } from "@/app/dashboard/_components/SaveBanner";
import type { Service, ServiceCategory } from "@/types/database";

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px",
  borderRadius: "4px",
  border: "1px solid #ccc",
  boxSizing: "border-box",
  fontSize: "14px",
};

const btnPrimary: React.CSSProperties = {
  padding: "8px 16px",
  background: "#0070f3",
  color: "#fff",
  border: "none",
  borderRadius: "4px",
  cursor: "pointer",
  fontSize: "14px",
};

const btnSmall: React.CSSProperties = {
  padding: "4px 10px",
  border: "1px solid #ccc",
  borderRadius: "4px",
  cursor: "pointer",
  background: "#fff",
  fontSize: "13px",
};

const formBox: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "16px",
  border: "1px solid #e0e0e0",
  borderRadius: "8px",
  marginBottom: "16px",
  background: "#fafafa",
};

function ServiceForm({
  action,
  categories,
  service,
}: {
  action: (fd: FormData) => Promise<void>;
  categories: ServiceCategory[];
  service?: Service;
}) {
  return (
    <form action={action} style={formBox}>
      {service && <input type="hidden" name="id" value={service.id} />}

      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={{ fontWeight: "500", fontSize: "14px" }}>שם *</span>
        <input name="name" required defaultValue={service?.name ?? ""} style={inputStyle} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={{ fontWeight: "500", fontSize: "14px" }}>תיאור</span>
        <textarea
          name="description"
          defaultValue={service?.description ?? ""}
          rows={2}
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={{ fontWeight: "500", fontSize: "14px" }}>משך (דקות) *</span>
        <input
          name="duration_minutes"
          type="number"
          min="5"
          step="5"
          required
          defaultValue={service?.duration_minutes ?? 30}
          style={inputStyle}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={{ fontWeight: "500", fontSize: "14px" }}>מחיר (₪)</span>
        <input
          name="price"
          type="number"
          step="0.01"
          min="0"
          defaultValue={service?.price ?? ""}
          placeholder="השאר ריק להסתרת מחיר"
          style={inputStyle}
        />
      </label>

      {categories.length > 0 && (
        <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontWeight: "500", fontSize: "14px" }}>קטגוריה (אופציונלי)</span>
          <select name="category_id" defaultValue={service?.category_id ?? ""} style={inputStyle}>
            <option value="">— ללא —</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
        </label>
      )}

      <div style={{ display: "flex", gap: "8px" }}>
        <button type="submit" style={btnPrimary}>
          {service ? "שמור שינויים" : "הוסף שירות"}
        </button>
        <a href="/dashboard/services" style={{ textDecoration: "none" }}>
          <button type="button" style={btnSmall}>ביטול</button>
        </a>
      </div>
    </form>
  );
}

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; edit?: string; saved?: string; error?: string }>;
}) {
  const businessId = getDefaultBusinessId();
  const [services, categories, params] = await Promise.all([
    getServices(businessId),
    getServiceCategories(businessId),
    searchParams,
  ]);

  const mode = params.mode;
  const editId = params.edit;
  const editService = editId ? services.find((s) => s.id === editId) : undefined;

  return (
    <div>
      {!mode && !editId && <SaveBanner saved={params.saved} error={params.error} />}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "16px",
        }}
      >
        <h1 style={{ margin: 0 }}>שירותים</h1>
        {!mode && !editId && (
          <a href="/dashboard/services?mode=create" style={{ textDecoration: "none" }}>
            <button style={btnPrimary}>+ הוסף שירות</button>
          </a>
        )}
      </div>

      {mode === "create" && (
        <ServiceForm action={createServiceAction} categories={categories} />
      )}

      {services.length === 0 && !mode && (
        <p style={{ color: "#666" }}>אין שירותים עדיין. הוסף את השירות הראשון שלך כדי להתחיל.</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {services.map((service) =>
          editId === service.id && editService ? (
            <ServiceForm
              key={service.id}
              action={updateServiceAction}
              categories={categories}
              service={editService}
            />
          ) : (
            <div
              key={service.id}
              style={{
                border: "1px solid #e0e0e0",
                borderRadius: "8px",
                padding: "12px 16px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                opacity: service.active ? 1 : 0.55,
              }}
            >
              <div>
                <strong>{service.name}</strong>
                <span style={{ color: "#666", marginRight: "12px", fontSize: "14px" }}>
                  {service.duration_minutes} דק׳
                </span>
                {service.price != null && (
                  <span style={{ color: "#444", marginRight: "8px", fontSize: "14px" }}>
                    ₪{Number(service.price).toFixed(0)}
                  </span>
                )}
                {!service.active && (
                  <span style={{ color: "#999", marginRight: "8px", fontSize: "12px" }}>(לא פעיל)</span>
                )}
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <a href={`/dashboard/services?edit=${service.id}`} style={{ textDecoration: "none" }}>
                  <button style={btnSmall}>ערוך</button>
                </a>
                <form action={toggleServiceActiveAction}>
                  <input type="hidden" name="id" value={service.id} />
                  <input type="hidden" name="active" value={String(!service.active)} />
                  <button type="submit" style={btnSmall}>
                    {service.active ? "השבת" : "הפעל"}
                  </button>
                </form>
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
