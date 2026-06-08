import { loginAction } from "./actions";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<Record<string, string>>;
}

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const hasError = params.error === "1";
  const hasPassword = Boolean(process.env.DASHBOARD_ACCESS_PASSWORD);

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        direction: "rtl",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f5f5",
      }}
    >
      <div
        style={{
          background: "#fff",
          padding: "40px 48px",
          borderRadius: "8px",
          boxShadow: "0 2px 12px rgba(0,0,0,.12)",
          maxWidth: "400px",
          width: "100%",
        }}
      >
        <h1 style={{ margin: "0 0 8px", fontSize: "22px" }}>מזכירה חכמה</h1>
        <p style={{ margin: "0 0 28px", color: "#666", fontSize: "14px" }}>
          כניסה לממשק הניהול
        </p>

        {!hasPassword && (
          <div
            style={{
              background: "#fff3cd",
              border: "1px solid #ffc107",
              borderRadius: "6px",
              padding: "12px 16px",
              marginBottom: "24px",
              fontSize: "13px",
              color: "#856404",
            }}
          >
            ⚠️ <strong>DASHBOARD_ACCESS_PASSWORD</strong> לא הוגדר בסביבת העבודה.
            <br />
            לחץ &quot;כניסה&quot; כדי להיכנס ללא סיסמה.
          </div>
        )}

        {hasError && (
          <div
            style={{
              background: "#f8d7da",
              border: "1px solid #f5c2c7",
              borderRadius: "6px",
              padding: "10px 16px",
              marginBottom: "20px",
              fontSize: "13px",
              color: "#842029",
            }}
          >
            סיסמה שגויה. נסה שוב.
          </div>
        )}

        <form action={loginAction}>
          {hasPassword && (
            <div style={{ marginBottom: "20px" }}>
              <label
                htmlFor="password"
                style={{ display: "block", marginBottom: "6px", fontWeight: "600", fontSize: "14px" }}
              >
                סיסמה
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  border: "1px solid #ddd",
                  borderRadius: "6px",
                  fontSize: "15px",
                  boxSizing: "border-box",
                  direction: "ltr",
                }}
              />
            </div>
          )}

          <button
            type="submit"
            style={{
              width: "100%",
              padding: "11px",
              background: "#111",
              color: "#fff",
              border: "none",
              borderRadius: "6px",
              fontSize: "15px",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            כניסה
          </button>
        </form>
      </div>
    </div>
  );
}
