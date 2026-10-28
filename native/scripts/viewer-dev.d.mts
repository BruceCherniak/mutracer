export const subsecondVersion: '0.7.10';
export function viewerDevOptions(
  args: string[],
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
): {
  help: boolean;
  out: string;
  target: string;
  env: NodeJS.ProcessEnv;
  command: string;
  args: string[];
};
export function checkDxVersion(command: string, env: NodeJS.ProcessEnv): void;
