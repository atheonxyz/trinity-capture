import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
    if (argv1 === undefined)
        return false;
    try {
        return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
    }
    catch (error) {
        if (error instanceof Error)
            return false;
        throw error;
    }
}
