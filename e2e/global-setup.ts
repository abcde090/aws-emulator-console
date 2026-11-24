import { verifyEmulatorAccount } from "./aws-cli";

/** Refuses to run any test unless the aws CLI reaches the emulator's account. */
export default async function globalSetup(): Promise<void> {
  await verifyEmulatorAccount();
}
