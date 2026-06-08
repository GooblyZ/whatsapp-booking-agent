export const dynamic = "force-dynamic";

import { getDefaultBusinessId } from "@/lib/config";
import { getStaffMembers } from "@/lib/services/staff";
import {
  createStaffAction,
  updateStaffAction,
  toggleStaffActiveAction,
} from "./actions";
import { SaveBanner } from "@/app/dashboard/_components/SaveBanner";
import type { StaffMember } from "@/types/database";

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

function StaffForm({
  action,
  member,
}: {
  action: (fd: FormData) => Promise<void>;
  member?: StaffMember;
}) {
  return (
    <form action={action} style={formBox}>
      {member && <input type="hidden" name="id" value={member.id} />}

      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={{ fontWeight: "500", fontSize: "14px" }}>שם *</span>
        <input name="name" required defaultValue={member?.name ?? ""} style={inputStyle} />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={{ fontWeight: "500", fontSize: "14px" }}>טלפון</span>
        <input name="phone" defaultValue={member?.phone ?? ""} style={inputStyle} />
      </label>

      <div style={{ display: "flex", gap: "8px" }}>
        <button type="submit" style={btnPrimary}>
          {member ? "שמור שינויים" : "הוסף איש צוות"}
        </button>
        <a href="/dashboard/staff" style={{ textDecoration: "none" }}>
          <button type="button" style={btnSmall}>ביטול</button>
        </a>
      </div>
    </form>
  );
}

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; edit?: string; saved?: string; error?: string }>;
}) {
  const businessId = getDefaultBusinessId();
  const [staff, params] = await Promise.all([getStaffMembers(businessId), searchParams]);

  const mode = params.mode;
  const editId = params.edit;
  const editMember = editId ? staff.find((s) => s.id === editId) : undefined;

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
        <h1 style={{ margin: 0 }}>צוות</h1>
        {!mode && !editId && (
          <a href="/dashboard/staff?mode=create" style={{ textDecoration: "none" }}>
            <button style={btnPrimary}>+ הוסף איש צוות</button>
          </a>
        )}
      </div>

      {mode === "create" && <StaffForm action={createStaffAction} />}

      {staff.length === 0 && !mode && (
        <p style={{ color: "#666" }}>
          אין אנשי צוות עדיין. עסק של אדם אחד? אין צורך בהגדרת צוות — שיוך צוות לתורים הוא תמיד אופציונלי.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {staff.map((member) =>
          editId === member.id && editMember ? (
            <StaffForm key={member.id} action={updateStaffAction} member={editMember} />
          ) : (
            <div
              key={member.id}
              style={{
                border: "1px solid #e0e0e0",
                borderRadius: "8px",
                padding: "12px 16px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                opacity: member.active ? 1 : 0.55,
              }}
            >
              <div>
                <strong>{member.name}</strong>
                {member.phone && (
                  <span style={{ color: "#666", marginRight: "12px", fontSize: "14px" }}>
                    {member.phone}
                  </span>
                )}
                {!member.active && (
                  <span style={{ color: "#999", marginRight: "8px", fontSize: "12px" }}>(לא פעיל)</span>
                )}
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <a href={`/dashboard/staff?edit=${member.id}`} style={{ textDecoration: "none" }}>
                  <button style={btnSmall}>ערוך</button>
                </a>
                <form action={toggleStaffActiveAction}>
                  <input type="hidden" name="id" value={member.id} />
                  <input type="hidden" name="active" value={String(!member.active)} />
                  <button type="submit" style={btnSmall}>
                    {member.active ? "השבת" : "הפעל"}
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
