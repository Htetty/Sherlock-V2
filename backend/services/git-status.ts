export function parseGitStatusPorcelainZ(output: string): string[] {
  const entries = output.split("\0");
  const paths: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (!entry) {
      continue;
    }

    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);

    if (filePath) {
      paths.push(filePath);
    }

    if (status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C") {
      index += 1;
    }
  }

  return paths;
}
