/**
 * Same-origin GET so the session cookie is sent and the browser saves the file.
 * Fetch + blob would also work; a link is enough and does not sit on "Downloading…".
 */
export function BackupDownload({
  pharmacyId,
  pharmacyName,
}: {
  pharmacyId: string;
  pharmacyName: string;
}) {
  return (
    <div className="card space-y-3 p-5">
      <h2 className="text-sm font-semibold text-slate-900">Backup</h2>
      <p className="text-sm text-slate-500">
        Download this pharmacy&apos;s records from the database: catalogue, stock,
        bills, purchases, suppliers, customers, staff and settings. Nothing from
        any other shop is included.
      </p>
      <a href={`/api/pharmacies/${pharmacyId}/backup`} className="btn-primary">
        Download {pharmacyName} backup
      </a>
      <p className="text-[11px] leading-relaxed text-slate-400">
        JSON file. Passwords are not in it. Keep the file off shared machines.
      </p>
    </div>
  );
}
