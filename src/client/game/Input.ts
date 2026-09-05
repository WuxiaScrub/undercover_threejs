/** Keyboard + pointer-lock mouse input. Nothing gameplay-specific lives here. */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressedThisFrame = new Set<string>();

  mouseDX = 0;
  mouseDY = 0;
  pointerLocked = false;

  private readonly buttons = new Set<number>();
  private wheelAccum = 0;
  private wheelSteps = 0;
  private readonly buttonsPressedThisFrame = new Set<number>();

  /** Fired when the pointer is locked — the user gesture audio needs. */
  onPointerLock: () => void = () => {};

  constructor(
    private readonly canvas: HTMLElement,
    private readonly overlay: HTMLElement,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('wheel', this.onWheel, { passive: false });
    // Right click draws and puts away the weapon; never let the browser menu
    // interrupt a firefight.
    document.addEventListener('contextmenu', (e) => {
      if (this.pointerLocked) e.preventDefault();
    });
    overlay.addEventListener('click', this.requestLock);
  }

  private readonly requestLock = () => {
    void this.canvas.requestPointerLock();
  };

  private readonly onPointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    this.overlay.classList.toggle('hidden', this.pointerLocked);
    if (this.pointerLocked) this.onPointerLock();
    if (!this.pointerLocked) {
      this.down.clear();
      this.buttons.clear();
      this.wheelSteps = 0;
      this.wheelAccum = 0;
    }
  };

  private readonly onMouseDown = (e: MouseEvent) => {
    if (!this.pointerLocked) return;
    this.buttons.add(e.button);
    this.buttonsPressedThisFrame.add(e.button);
  };

  private readonly onMouseUp = (e: MouseEvent) => {
    this.buttons.delete(e.button);
  };

  private readonly onWheel = (e: WheelEvent) => {
    if (!this.pointerLocked) return;
    e.preventDefault();
    // Accumulated in NOTCHES, not pixels: trackpads and mice report wildly
    // different deltaY magnitudes and one notch should always be one weapon.
    this.wheelAccum += e.deltaY;
    const notch = 40;
    while (this.wheelAccum >= notch) {
      this.wheelAccum -= notch;
      this.wheelSteps += 1;
    }
    while (this.wheelAccum <= -notch) {
      this.wheelAccum += notch;
      this.wheelSteps -= 1;
    }
  };

  private readonly onMouseMove = (e: MouseEvent) => {
    if (!this.pointerLocked) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };

  private readonly onKeyDown = (e: KeyboardEvent) => {
    // F-keys are debug controls; stop the browser from stealing them.
    if (/^F\d+$/.test(e.code)) e.preventDefault();
    if (e.repeat) return;
    this.down.add(e.code);
    this.pressedThisFrame.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };

  private readonly onBlur = () => {
    this.down.clear();
    this.buttons.clear();
  };

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  /** 0 = left, 2 = right. Held — for automatic fire and for aiming. */
  mouseDown(button: number): boolean {
    return this.buttons.has(button);
  }

  mousePressed(button: number): boolean {
    return this.buttonsPressedThisFrame.has(button);
  }

  /** Whole scroll notches since the last frame. Positive = scrolled down. */
  consumeWheel(): number {
    const steps = this.wheelSteps;
    this.wheelSteps = 0;
    return steps;
  }

  /** Movement axes in local space: x = right, z = forward. */
  moveAxes(): { x: number; z: number } {
    let x = 0;
    let z = 0;
    if (this.isDown('KeyW')) z += 1;
    if (this.isDown('KeyS')) z -= 1;
    if (this.isDown('KeyD')) x += 1;
    if (this.isDown('KeyA')) x -= 1;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    return { x, z };
  }

  get sprint(): boolean {
    return this.isDown('ShiftLeft') || this.isDown('ShiftRight');
  }

  consumeMouseDelta(): { dx: number; dy: number } {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  endFrame(): void {
    this.pressedThisFrame.clear();
    this.buttonsPressedThisFrame.clear();
  }
}
