export const dynamic = "force-dynamic";

import { getDefaultBusinessId } from "@/lib/config";
import { getAISettings } from "@/lib/services/ai-settings";
import { getKnowledgeBaseItems } from "@/lib/services/knowledge-base";
import {
  saveAISettingsAction,
  createKBItemAction,
  updateKBItemAction,
  toggleKBItemActiveAction,
  deleteKBItemAction,
} from "./actions";
import { SaveBanner } from "@/app/dashboard/_components/SaveBanner";
import type { KnowledgeBaseItem } from "@/types/database";

const CATEGORY_LABELS: Record<string, string> = {
  faq: "שאלות נפוצות",
  pricing: "תמחור",
  parking: "חניה",
  policy: "מדיניות",
  contact: "יצירת קשר",
  custom: "מידע נוסף",
};

const CATEGORIES = ["faq", "pricing", "parking", "policy", "contact", "custom"] as const;

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

const btnDanger: React.CSSProperties = {
  padding: "4px 10px",
  border: "1px solid #f0a0a0",
  borderRadius: "4px",
  cursor: "pointer",
  background: "#fff",
  fontSize: "13px",
  color: "#c00",
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

const sectionTitle: React.CSSProperties = {
  fontSize: "18px",
  fontWeight: "600",
  margin: "0 0 4px 0",
};

const divider: React.CSSProperties = {
  border: "none",
  borderTop: "1px solid #e0e0e0",
  margin: "32px 0",
};

function KBForm({
  action,
  item,
}: {
  action: (fd: FormData) => Promise<void>;
  item?: KnowledgeBaseItem;
}) {
  return (
    <form action={action} style={formBox}>
      {item && <input type="hidden" name="id" value={item.id} />}

      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={{ fontWeight: "500", fontSize: "14px" }}>קטגוריה</span>
        <select name="category" defaultValue={item?.category ?? "faq"} style={inputStyle}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
          ))}
        </select>
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={{ fontWeight: "500", fontSize: "14px" }}>כותרת / שאלה *</span>
        <input
          name="title"
          required
          defaultValue={item?.title ?? ""}
          placeholder="לדוגמה: האם יש חניה?"
          style={inputStyle}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={{ fontWeight: "500", fontSize: "14px" }}>תוכן / תשובה *</span>
        <textarea
          name="content"
          required
          defaultValue={item?.content ?? ""}
          rows={4}
          placeholder="לדוגמה: כן, יש חניה חינם מאחורי הבניין."
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </label>

      <div style={{ display: "flex", gap: "8px" }}>
        <button type="submit" style={btnPrimary}>
          {item ? "שמור שינויים" : "הוסף ידע"}
        </button>
        <a href="/dashboard/ai-assistant" style={{ textDecoration: "none" }}>
          <button type="button" style={btnSmall}>ביטול</button>
        </a>
      </div>
    </form>
  );
}

export default async function AIAssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; edit?: string; saved?: string }>;
}) {
  const businessId = getDefaultBusinessId();
  const [aiSettings, kbItems, params] = await Promise.all([
    getAISettings(businessId),
    getKnowledgeBaseItems(businessId),
    searchParams,
  ]);

  const mode = params.mode;
  const editId = params.edit;
  const editItem = editId ? kbItems.find((i) => i.id === editId) : undefined;

  return (
    <div>
      <h1>עוזר AI</h1>
      {!mode && !editId && <SaveBanner saved={params.saved} />}

      {/* ── Section 1: Behavior Settings ───────────────────────────────── */}
      <h2 style={sectionTitle}>הגדרות התנהגות</h2>
      <p style={{ color: "#666", marginTop: "4px", marginBottom: "16px" }}>
        קבע כיצד העוזר מתנהג ומתקשר עם הלקוחות. הגדרות אלו ייכנסו לתוקף עם הפעלת הבינה המלאכותית.
      </p>

      <form
        action={saveAISettingsAction}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          maxWidth: "480px",
          marginBottom: "8px",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontWeight: "500", fontSize: "14px" }}>שם העוזר</span>
          <input
            name="assistant_name"
            defaultValue={aiSettings?.assistant_name ?? "עוזר"}
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontWeight: "500", fontSize: "14px" }}>טון דיבור</span>
          <select name="tone" defaultValue={aiSettings?.tone ?? "friendly"} style={inputStyle}>
            <option value="friendly">ידידותי</option>
            <option value="professional">מקצועי</option>
            <option value="luxury">יוקרתי</option>
            <option value="casual">קז&#39;ואל</option>
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontWeight: "500", fontSize: "14px" }}>אורך תשובות</span>
          <select name="response_length" defaultValue={aiSettings?.response_length ?? "medium"} style={inputStyle}>
            <option value="short">קצר</option>
            <option value="medium">בינוני</option>
            <option value="long">ארוך</option>
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontWeight: "500", fontSize: "14px" }}>שימוש באמוג&#39;י</span>
          <select name="emoji_usage" defaultValue={aiSettings?.emoji_usage ?? "low"} style={inputStyle}>
            <option value="none">ללא</option>
            <option value="low">מועט</option>
            <option value="medium">בינוני</option>
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontWeight: "500", fontSize: "14px" }}>שפה</span>
          <input
            name="language"
            defaultValue={aiSettings?.language ?? "he"}
            placeholder="he, en, ar"
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontWeight: "500", fontSize: "14px" }}>הוראות מיוחדות</span>
          <textarea
            name="custom_instructions"
            defaultValue={aiSettings?.custom_instructions ?? ""}
            rows={4}
            placeholder="לדוגמה: תמיד פנה ללקוחות בגוף שני, אל תדון במחירים ללא בקשה."
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </label>

        <button type="submit" style={{ ...btnPrimary, alignSelf: "flex-start", padding: "10px 20px" }}>
          שמור הגדרות
        </button>
      </form>

      <hr style={divider} />

      {/* ── Section 2: Knowledge Base ───────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "8px",
        }}
      >
        <h2 style={sectionTitle}>בסיס ידע</h2>
        {!mode && !editId && (
          <a href="/dashboard/ai-assistant?mode=create" style={{ textDecoration: "none" }}>
            <button style={btnPrimary}>+ הוסף ידע</button>
          </a>
        )}
      </div>

      {!mode && !editId && (
        <p style={{ color: "#666", marginTop: "4px", marginBottom: "16px" }}>
          הוסף מידע על העסק שהעוזר ישתמש בו לענות על שאלות לקוחות: שעות פעילות, כתובת, חניה, מדיניות ביטולים, ועוד.
        </p>
      )}

      {mode === "create" && <KBForm action={createKBItemAction} />}

      {kbItems.length === 0 && !mode && (
        <p style={{ color: "#888" }}>אין ידע עדיין. הוסף את הפריט הראשון כדי שהעוזר יוכל לענות על שאלות לקוחות.</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {kbItems.map((item) =>
          editId === item.id && editItem ? (
            <KBForm key={item.id} action={updateKBItemAction} item={editItem} />
          ) : (
            <div
              key={item.id}
              style={{
                border: "1px solid #e0e0e0",
                borderRadius: "8px",
                padding: "12px 16px",
                opacity: item.active ? 1 : 0.55,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: "6px",
                  gap: "8px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontSize: "11px",
                      background: "#f0f0f0",
                      padding: "2px 7px",
                      borderRadius: "4px",
                      fontWeight: "500",
                    }}
                  >
                    {CATEGORY_LABELS[item.category] ?? item.category}
                  </span>
                  <strong>{item.title}</strong>
                  {!item.active && (
                    <span style={{ color: "#999", fontSize: "12px" }}>(לא פעיל)</span>
                  )}
                </div>
                <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                  <a href={`/dashboard/ai-assistant?edit=${item.id}`} style={{ textDecoration: "none" }}>
                    <button style={btnSmall}>ערוך</button>
                  </a>
                  <form action={toggleKBItemActiveAction} style={{ display: "inline" }}>
                    <input type="hidden" name="id" value={item.id} />
                    <input type="hidden" name="active" value={String(!item.active)} />
                    <button type="submit" style={btnSmall}>
                      {item.active ? "השבת" : "הפעל"}
                    </button>
                  </form>
                  <form action={deleteKBItemAction} style={{ display: "inline" }}>
                    <input type="hidden" name="id" value={item.id} />
                    <button type="submit" style={btnDanger}>מחק</button>
                  </form>
                </div>
              </div>
              <p style={{ margin: 0, fontSize: "14px", color: "#444", whiteSpace: "pre-wrap" }}>
                {item.content}
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
