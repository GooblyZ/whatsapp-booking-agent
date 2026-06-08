// Shared save-feedback banner for all dashboard forms.
// Usage: <SaveBanner saved={params.saved} error={params.error} />
// Actions redirect to ?saved=1 on success, ?error=X on failure.

const successStyle: React.CSSProperties = {
  background: "#d4edda",
  border: "1px solid #c3e6cb",
  color: "#155724",
  borderRadius: "6px",
  padding: "10px 16px",
  fontSize: "14px",
  marginBottom: "20px",
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const errorStyle: React.CSSProperties = {
  background: "#fff3cd",
  border: "1px solid #ffc107",
  color: "#856404",
  borderRadius: "6px",
  padding: "10px 16px",
  fontSize: "14px",
  marginBottom: "20px",
  lineHeight: "1.6",
};

interface Props {
  saved?: string;
  error?: string;
}

export function SaveBanner({ saved, error }: Props) {
  if (error === "invalid_phone") {
    return (
      <div style={errorStyle} role="alert">
        <strong>⚠️ מספר הטלפון שהזנת אינו תקין ולא נשמר.</strong>
        <br />
        פורמטים מקובלים:{" "}
        <code style={{ background: "#ffeeba", padding: "1px 4px", borderRadius: "3px" }}>050-1234567</code>
        {" "}או{" "}
        <code style={{ background: "#ffeeba", padding: "1px 4px", borderRadius: "3px" }}>+972501234567</code>
        .
      </div>
    );
  }

  if (error === "invalid_timezone") {
    return (
      <div style={errorStyle} role="alert">
        <strong>⚠️ אזור הזמן שהזנת אינו תקין ולא נשמר.</strong>
        <br />
        השתמש בפורמט IANA, לדוגמה:{" "}
        <code style={{ background: "#ffeeba", padding: "1px 4px", borderRadius: "3px" }}>
          Asia/Jerusalem
        </code>
        ,{" "}
        <code style={{ background: "#ffeeba", padding: "1px 4px", borderRadius: "3px" }}>
          Europe/London
        </code>
        ,{" "}
        <code style={{ background: "#ffeeba", padding: "1px 4px", borderRadius: "3px" }}>
          UTC
        </code>
        .<br />
        <span style={{ fontSize: "13px" }}>שאר ההגדרות נשמרו בהצלחה.</span>
      </div>
    );
  }

  if (saved === "1") {
    return (
      <div style={successStyle} role="status">
        <span style={{ fontSize: "16px" }}>✅</span>
        <span>ההגדרות נשמרו בהצלחה.</span>
      </div>
    );
  }

  return null;
}
