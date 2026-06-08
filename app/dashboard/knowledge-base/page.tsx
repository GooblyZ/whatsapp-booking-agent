export const dynamic = "force-dynamic";

import { getDefaultBusinessId } from "@/lib/config";
import { getKnowledgeBaseItems } from "@/lib/services/knowledge-base";
import {
  createKBItemAction,
  updateKBItemAction,
  toggleKBItemActiveAction,
  deleteKBItemAction,
} from "./actions";
import { SaveBanner } from "@/app/dashboard/_components/SaveBanner";
import type { KnowledgeBaseItem } from "@/types/database";

// ── Category config ─────────────────────────────────────────────

const CATEGORIES = [
  "about", "faq", "pricing", "parking", "policy", "contact", "custom",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  about:   "אודות העסק",
  faq:     "שאלות נפוצות",
  pricing: "תמחור",
  parking: "חניה והגעה",
  policy:  "מדיניות",
  contact: "יצירת קשר",
  custom:  "מידע נוסף",
};

// "about" is the primary category — shown with a special hint
const CATEGORY_HINTS: Partial<Record<string, string>> = {
  about:   "תאר את העסק: מי אתה, מה אתה מציע, מה הייחודיות שלך. זה מה שהבוט אומר כשמישהו שואל \"מה אתם עושים?\"",
  parking: "הוסף הוראות חניה, כניסה ומציאת המקום. ניתן להוסיף כמה פריטים.",
  policy:  "מדיניות ביטולים, החזרות, או כל מדיניות רלוונטית אחרת.",
};

// ── Styles ──────────────────────────────────────────────────────

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

// ── KB Form component ────────────────────────────────────────────

function KBForm({
  action,
  item,
  defaultCategory,
}: {
  action: (fd: FormData) => Promise<void>;
  item?: KnowledgeBaseItem;
  defaultCategory?: string;
}) {
  const selectedCat = item?.category ?? defaultCategory ?? "faq";
  const hint = CATEGORY_HINTS[selectedCat];

  return (
    <form action={action} style={formBox}>
      {item && <input type="hidden" name="id" value={item.id} />}

      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={{ fontWeight: "500", fontSize: "14px" }}>קטגוריה</span>
        <select name="category" defaultValue={selectedCat} style={inputStyle}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        {hint && (
          <span style={{ fontSize: "12px", color: "#888", lineHeight: "1.5" }}>{hint}</span>
        )}
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={{ fontWeight: "500", fontSize: "14px" }}>כותרת / שאלה *</span>
        <input
          name="title"
          required
          minLength={3}
          defaultValue={item?.title ?? ""}
          placeholder={selectedCat === "about" ? "לדוגמה: על העסק שלנו" : "לדוגמה: האם יש חניה?"}
          style={inputStyle}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={{ fontWeight: "500", fontSize: "14px" }}>תוכן / תשובה *</span>
        <textarea
          name="content"
          required
          minLength={10}
          defaultValue={item?.content ?? ""}
          rows={4}
          placeholder={
            selectedCat === "about"
              ? "לדוגמה: ספרייה משפחתית מאז 2004. מתמחים בתספורות גברים וילדים. ממוקמים ברחוב הרצל 15, תל אביב."
              : "לדוגמה: כן, יש חניה חינם מאחורי הבניין."
          }
          style={{ ...inputStyle, resize: "vertical" }}
        />
      </label>

      <div style={{ display: "flex", gap: "8px" }}>
        <button type="submit" style={btnPrimary}>
          {item ? "שמור שינויים" : "הוסף לבסיס הידע"}
        </button>
        <a href="/dashboard/knowledge-base" style={{ textDecoration: "none" }}>
          <button type="button" style={btnSmall}>ביטול</button>
        </a>
      </div>
    </form>
  );
}

// ── Page ─────────────────────────────────────────────────────────

export default async function KnowledgeBasePage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; edit?: string; saved?: string; error?: string; cat?: string }>;
}) {
  const businessId = getDefaultBusinessId();
  const [kbItems, params] = await Promise.all([
    getKnowledgeBaseItems(businessId),
    searchParams,
  ]);

  const mode   = params.mode;
  const editId = params.edit;
  const editItem = editId ? kbItems.find((i) => i.id === editId) : undefined;

  // Group items by category for display
  const byCategory: Record<string, KnowledgeBaseItem[]> = {};
  for (const item of kbItems) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }

  const hasAbout = (byCategory["about"]?.length ?? 0) > 0;

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "8px",
        }}
      >
        <h1 style={{ margin: 0 }}>בסיס ידע</h1>
        {!mode && !editId && (
          <a href="/dashboard/knowledge-base?mode=create" style={{ textDecoration: "none" }}>
            <button style={btnPrimary}>+ הוסף מידע</button>
          </a>
        )}
      </div>

      <p style={{ color: "#666", fontSize: "14px", marginTop: "4px", marginBottom: "16px" }}>
        כל מה שהבוט צריך לדעת על העסק שלך — תשובות לשאלות לקוחות, מיקום, מדיניות, ועוד.
      </p>

      {!mode && !editId && <SaveBanner saved={params.saved} error={params.error} />}

      {/* "About" nudge — shown when no about entry exists */}
      {!mode && !editId && !hasAbout && (
        <div
          style={{
            background: "#f0f7ff",
            border: "1px solid #b3d4ff",
            borderRadius: "8px",
            padding: "14px 18px",
            marginBottom: "20px",
            fontSize: "14px",
          }}
        >
          <strong>💡 התחל מ&quot;אודות העסק&quot;</strong>
          <br />
          <span style={{ color: "#555" }}>
            הוסף תיאור קצר של העסק שלך — זה מה שהבוט אומר כשלקוח שואל &quot;מה אתם עושים?&quot;
          </span>
          <div style={{ marginTop: "10px" }}>
            <a
              href="/dashboard/knowledge-base?mode=create&cat=about"
              style={{ textDecoration: "none" }}
            >
              <button style={btnPrimary}>הוסף אודות העסק →</button>
            </a>
          </div>
        </div>
      )}

      {mode === "create" && (
        <KBForm action={createKBItemAction} defaultCategory={params.cat ?? "faq"} />
      )}

      {kbItems.length === 0 && !mode && (
        <p style={{ color: "#888" }}>
          אין ידע עדיין. לחץ &quot;הוסף מידע&quot; כדי להתחיל.
        </p>
      )}

      {/* Grouped display by category */}
      {!mode && kbItems.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          {CATEGORIES.filter((c) => byCategory[c]?.length).map((cat) => (
            <div key={cat}>
              <div
                style={{
                  fontSize: "13px",
                  fontWeight: "600",
                  color: cat === "about" ? "#0070f3" : "#555",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  marginBottom: "8px",
                  paddingBottom: "6px",
                  borderBottom: "1px solid #eee",
                }}
              >
                {CATEGORY_LABELS[cat]}
                {cat === "about" && (
                  <span
                    style={{
                      marginRight: "8px",
                      fontSize: "11px",
                      background: "#e8f0fe",
                      color: "#0070f3",
                      padding: "2px 6px",
                      borderRadius: "3px",
                      fontWeight: "500",
                    }}
                  >
                    ראשי לבוט
                  </span>
                )}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {byCategory[cat].map((item) =>
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
                        background: "#fff",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: "6px",
                          gap: "8px",
                          flexWrap: "wrap",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <strong style={{ fontSize: "14px" }}>{item.title}</strong>
                          {!item.active && (
                            <span style={{ color: "#999", fontSize: "12px" }}>(לא פעיל)</span>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                          <a
                            href={`/dashboard/knowledge-base?edit=${item.id}`}
                            style={{ textDecoration: "none" }}
                          >
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
                      <p
                        style={{
                          margin: 0,
                          fontSize: "13px",
                          color: "#555",
                          whiteSpace: "pre-wrap",
                          lineHeight: "1.5",
                        }}
                      >
                        {item.content}
                      </p>
                    </div>
                  )
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
