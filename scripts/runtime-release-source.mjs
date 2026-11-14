/** Fail closed when a release would package an arbitrary sibling checkout. */
export function assertReleaseSource({ releaseMode, expectedCommit, actualCommit, sourceDirty }) {
  if (!releaseMode) return;
  if (!/^[a-f0-9]{40}$/i.test(String(expectedCommit || ''))) {
    throw new Error('Release bundling requires ONECLAW_RELEASE_COMMIT set to the full 40-character reviewed OneClaw commit.');
  }
  if (!/^[a-f0-9]{40}$/i.test(String(actualCommit || ''))) {
    throw new Error('Release bundling requires ONECLAW_DIR to be a Git checkout.');
  }
  if (String(actualCommit).toLowerCase() !== String(expectedCommit).toLowerCase()) {
    throw new Error(`OneClaw release pin mismatch: expected ${expectedCommit}, found ${actualCommit}.`);
  }
  if (sourceDirty) {
    throw new Error('OneClaw release source has uncommitted runtime inputs; commit or discard them before packaging.');
  }
}
