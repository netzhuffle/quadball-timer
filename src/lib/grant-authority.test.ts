import { describe, test } from "bun:test";
import {
  registerGrantAuthorityContract,
  type GrantAuthorityContractStorage,
} from "@/lib/grant-authority-contract";
import { createInMemoryFoundationStorage } from "@/lib/foundation-storage-memory";

describe("grant authority (memory)", () => {
  registerGrantAuthorityContract(test, (): GrantAuthorityContractStorage => {
    const storage = createInMemoryFoundationStorage();
    return { storage, cleanup: () => storage.close() };
  });
});
