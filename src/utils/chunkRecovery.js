export function isModuleLoadError(error) {
  const message = String(error?.message || error || '')
  return error?.name === 'ChunkLoadError' || /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading (?:CSS )?chunk .+ failed|Unable to preload CSS for/i.test(message)
}
