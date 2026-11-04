import {
  assertContainerSwapDisabled, protectedCredentialsRoot, publishProtectedCredentials,
} from "./protectedCredentials.js";

try {
  const root = protectedCredentialsRoot(process.env);
  if (root === undefined) throw new Error();
  assertContainerSwapDisabled();
  process.stdin.setEncoding("utf8");
  await publishProtectedCredentials(root, process.stdin);
} catch {
  console.error("Protected credential handoff failed");
  process.exitCode = 1;
}
