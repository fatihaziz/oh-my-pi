import { writeIsolationOwner } from "../../src/task/isolation-ownership";

await writeIsolationOwner(process.argv[2]!, "OwnerProbe");
