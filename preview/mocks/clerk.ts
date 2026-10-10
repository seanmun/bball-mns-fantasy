// The preview harness has no Clerk. Components that ask who is signed
// in get a fixed member; nothing here talks to Clerk.
export function useUser() {
  return { user: { id: 'preview-user', username: 'preview' }, isSignedIn: true, isLoaded: true }
}
export function useAuth() {
  return { getToken: async () => 'preview-token', userId: 'preview-user', isSignedIn: true, isLoaded: true }
}
