import type { ConnectionStatus } from '../net/Connection';

const NAME_KEY = 'compound.name';

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  offline: 'offline — solo',
  connecting: 'connecting…',
  online: 'connected',
  error: 'connection failed',
};

/**
 * The join panel on the click-to-play overlay. Deliberately tiny: type a name,
 * confirm the host address, play. The address is pre-filled with whatever host
 * served the page, so on a LAN nobody has to type an IP at all.
 */
export class NetPanel {
  onConnect: (url: string, name: string) => void = () => {};
  onDisconnect: () => void = () => {};

  private readonly nameInput: HTMLInputElement;
  private readonly addressInput: HTMLInputElement;
  private readonly statusEl: HTMLElement;

  constructor(root: HTMLElement, defaultAddress: string) {
    this.nameInput = root.querySelector('#net-name')!;
    this.addressInput = root.querySelector('#net-address')!;
    this.statusEl = root.querySelector('#net-status')!;

    this.addressInput.value = defaultAddress;
    this.nameInput.value = loadName();

    // The overlay itself grabs pointer lock on click; the panel must not.
    root.addEventListener('click', (e) => e.stopPropagation());

    root.querySelector('#net-connect')!.addEventListener('click', () => this.connect());
    root.querySelector('#net-offline')!.addEventListener('click', () => this.onDisconnect());
    this.nameInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.connect();
    });
    this.addressInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.connect();
    });
  }

  get name(): string {
    return this.nameInput.value.trim() || 'player';
  }

  get address(): string {
    return this.addressInput.value.trim();
  }

  private connect(): void {
    saveName(this.nameInput.value.trim());
    this.onConnect(this.address, this.name);
  }

  setStatus(status: ConnectionStatus, detail: string, playerCount: number): void {
    const base =
      status === 'online'
        ? `${STATUS_TEXT.online} — ${playerCount + 1} in the compound`
        : STATUS_TEXT[status];
    this.statusEl.textContent = detail ? `${base} · ${detail}` : base;
    this.statusEl.dataset.status = status;
  }
}

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
  } catch {
    // Private windows and blocked site data: a remembered name is a nicety.
  }
}
