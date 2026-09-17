import path from "path"

process.env.OPENCODE_DB = ":memory:"
process.env.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
// Existing config and plugin tests load project content as if the folder were trusted; workspace trust tests set their
// own policy with WorkspaceTrustLaunch.set.
process.env.OPENCODE_WORKSPACE_TRUST = "trusted"
