import styles from './GuestReportsImport.module.css';

export default function RoomOpsUploadControl({ open, busy, onDrive, onFile, onToggle }: {
  open: boolean; busy: boolean; onDrive: () => void; onFile: () => void; onToggle: () => void;
}) {
  return <div className={styles.uploadControl}>
    <span className={styles.controlTitle}>Upload Room Ops</span>
    <div className={styles.splitFrame} role="group" aria-label="Upload Room Ops">
      <button type="button" className={styles.drive} disabled={busy} onClick={onDrive} aria-controls="room-ops-upload-form" aria-expanded={open}>
        <span>Drive<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M8 3h8l7 12-4 7H5l-4-7 7-12Z M8 3l11 19 M16 3 5 22 M1 15h22"/></svg></span>
      </button>
      <button type="button" className={styles.file} disabled={busy} onClick={onFile} aria-controls="room-ops-upload-form" aria-expanded={open}>
        <span>File<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M2 7V5a2 2 0 0 1 2-2h5l3 4h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7Z"/></svg></span>
      </button>
      <button type="button" className={styles.disclosure} disabled={busy} onClick={onToggle} aria-label={open ? 'Collapse upload form' : 'Expand upload form'} aria-controls="room-ops-upload-form" aria-expanded={open}><svg aria-hidden="true" viewBox="0 0 10 6"><path fill="currentColor" d={open?'M0 6 5 0l5 6Z':'M0 0h10L5 6Z'}/></svg></button>
    </div>
  </div>;
}
