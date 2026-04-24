import fs from "node:fs";
import yaml from "js-yaml";

export function loadConfig(configPath, { optional = false } = {}) {
  if (!fs.existsSync(configPath)) {
    if (optional) return {};
    throw new Error(
      `설정 파일을 찾을 수 없음: ${configPath}\n` +
      `'safeship.config.example.yaml'을 '${configPath}'로 복사한 후 값을 채우세요.`
    );
  }
  const content = fs.readFileSync(configPath, "utf-8");
  return yaml.load(content) || {};
}
