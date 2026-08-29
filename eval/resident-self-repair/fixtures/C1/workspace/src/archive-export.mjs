export function exportArchive(records) {
  return JSON.stringify({ version: 1, records });
}
