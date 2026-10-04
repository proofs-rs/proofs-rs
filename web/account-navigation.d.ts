interface Window {
  proofsAccountNavigation(
    container: HTMLElement,
    me: { user?: { username: string; role: string } | null; karma?: number },
    siteRoot: string,
    logout: () => Promise<void>,
    onError: (error: unknown) => void,
    showStarKarma?: boolean,
  ): void;
}
