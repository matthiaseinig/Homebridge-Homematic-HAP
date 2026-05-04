import { HomematicPlatform } from "./platform.js";
import { PLATFORM_NAME } from "./settings.js";
var src_default = (api) => {
  api.registerPlatform(PLATFORM_NAME, HomematicPlatform);
};
export {
  src_default as default
};
//# sourceMappingURL=index.js.map
