export function getDefaultBusinessId(): string {
  const id = process.env.DEFAULT_BUSINESS_ID;
  if (!id) throw new Error("DEFAULT_BUSINESS_ID env var is not set");
  return id;
}
