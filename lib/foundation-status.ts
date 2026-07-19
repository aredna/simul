export function createFoundationStatus(projectName: string): string {
  const normalizedName = projectName.trim();

  if (!normalizedName) {
    throw new Error('Project name is required.');
  }

  return `${normalizedName} is ready for product discovery.`;
}
