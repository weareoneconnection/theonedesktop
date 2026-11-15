export const REQUIRED_RUNTIME_CONTRACT = Object.freeze({
  contractVersion: 1,
  safeRecoverySwitch: 'ONECLAW_RECOVER_SAFE_TASKS_ON_BOOT',
  taskResultSchema: 'theone.code_execution_result.v2',
});

/**
 * Refuse to package an older OneClaw whose recovery policy predates the
 * Desktop fail-closed switch. A commit pin proves which source was reviewed;
 * this contract proves it is new enough for the environment Desktop sets.
 */
export function assertDesktopRuntimeContract(packageJson) {
  const contract = packageJson && packageJson.theoneDesktopRuntime;
  const schemas = Array.isArray(contract && contract.taskResultSchemas)
    ? contract.taskResultSchemas
    : [];
  if (contract?.contractVersion !== REQUIRED_RUNTIME_CONTRACT.contractVersion
    || contract?.safeRecoverySwitch !== REQUIRED_RUNTIME_CONTRACT.safeRecoverySwitch
    || !schemas.includes(REQUIRED_RUNTIME_CONTRACT.taskResultSchema)) {
    throw new Error(
      'OneClaw does not satisfy the Desktop runtime contract: use the reviewed third-batch OneClaw commit.',
    );
  }
  return contract;
}
