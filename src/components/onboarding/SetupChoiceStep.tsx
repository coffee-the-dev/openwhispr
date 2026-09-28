import { Fragment, forwardRef, useRef, useState } from "react";
import {
  BanknoteCheck,
  GalleryVerticalEnd,
  KeyRound,
  Laptop,
  Network,
  Server,
  WifiOff,
} from "../icons";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { getParakeetModelInfo } from "../../models/ModelRegistry";
import type { OnboardingSetupMode } from "./flow";
import { LOCAL_ASR_ORGANIZATIONS } from "../../helpers/localASROrganization";
import { getProviderIcon, isMonochromeProvider } from "@/utils/providerIcons";
import { cn } from "../lib/utils";
// Only the Local card opens the warning dialog; self-hosted goes straight
// to its server step.
import warningBackdrop from "../../assets/onboarding-setup-warning-hero.webp";

type SetupMode = Exclude<OnboardingSetupMode, null>;
type WarningSetupMode = Extract<SetupMode, "local">;

const REFERENCE_LOCAL_MODEL_ID = "nemotron-3.5-asr-streaming-0.6b";

interface SetupChoiceStepProps {
  onSelect: (mode: SetupMode) => void;
}

// Figma "Frame 49"–"Frame 52": row, gap 8, a tertiary 14px mark beside 14/140% body.
//
// strokeWidth stays at the icon set's default 2 rather than the 1.16667 the
// export shows. Both describe the same line: Figma exports these at viewBox
// 0 0 14 14, so its 1.16667 is already in 14px space, while the icons draw in a
// 24 viewBox scaled down to 14 — 2 x (14/24) = 1.1667 device px, exactly the
// spec. Passing 1.167 here applies the scale twice and renders a 0.68px hairline.
function Feature({ icon: Icon, children }: { icon: typeof Laptop; children: string }) {
  return (
    <li className="flex items-center gap-1.5 text-xs leading-[1.4] text-[var(--onboarding-text-primary)]">
      <Icon className="size-3 shrink-0 text-[var(--onboarding-text-tertiary)]" />
      {children}
    </li>
  );
}

// Compact setup card: content stays pinned to the top and the action to the bottom.
function SetupCard({ children }: { children: React.ReactNode }) {
  return (
    <section className="relative flex h-[350px] w-68 shrink-0 flex-col justify-between overflow-hidden rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-4 pb-5 pt-4 text-start">
      {children}
    </section>
  );
}

// Figma "Frame 25": pad 8 20, radius 38, 14/140% medium. Brand fill or stroke.
const CardAction = forwardRef<
  HTMLButtonElement,
  {
    brand?: boolean;
    className?: string;
    onClick: () => void;
    children: string;
  }
>(function CardAction({ brand = false, className = "", onClick, children }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={`onboarding-pressable relative z-10 w-full rounded-[38px] px-4 py-1.5 text-xs font-medium leading-[1.4] ${className} ${
        brand
          ? "bg-[var(--onboarding-accent)] text-[var(--onboarding-accent-foreground)] hover:brightness-95"
          : "border border-[var(--onboarding-control-border)] text-[var(--onboarding-text-primary)] hover:bg-[var(--onboarding-surface-hover)]"
      }`}
    >
      {children}
    </button>
  );
});

export default function SetupChoiceStep({ onSelect }: SetupChoiceStepProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<WarningSetupMode | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const localReferenceModel = getParakeetModelInfo(REFERENCE_LOCAL_MODEL_ID);
  // Two deliberately different numbers: the setup steps quote the transfer, so
  // they get the model's own download size, while the disk figure is rounded up
  // and floored at 2 GB because the model arrives as an archive and needs room
  // to unpack — quoting only the compressed size as the space requirement can
  // send a user into a setup that runs out of disk.
  const localModelSize = (localReferenceModel?.size ?? t("common.unknown")).replace(
    /(\d)([A-Za-z])/,
    "$1 $2"
  );
  const minimumLocalSpaceGb = Math.max(2, Math.ceil((localReferenceModel?.sizeMb ?? 0) / 1000));

  const confirmPending = () => {
    if (!pending) return;
    onSelect(pending);
    setPending(null);
  };

  // Radix otherwise focuses the first action (Cancel). Keep Enter aligned with
  // the mode the user just selected by focusing Proceed.
  const handleWarningAutoFocus = (event: Event) => {
    event.preventDefault();
    confirmRef.current?.focus();
  };

  const warningSteps = pending
    ? [1, 2, 3].map((step) =>
        t(`onboarding.rehaul.setupChoice.warnings.${pending}.steps.${step}`, {
          modelSize: localModelSize,
        })
      )
    : [];
  return (
    // Figma "Frame 2147259042": column, gap 32, centred — the card row.
    <div className="mx-auto mt-5 flex w-full flex-col items-center gap-4">
      {/* Frame 60: row, gap 16. */}
      <div className="onboarding-stagger flex items-start justify-center gap-3">
        <SetupCard>
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              {/* Frame 2147259034: the local model marks overlap by 8, each on a
                  1.33px surface ring so the stack reads front-to-back. NVIDIA's
                  tile is its own green field, so it fills the chip and is clipped
                  to the circle; the other marks sit inside it, with OpenAI's
                  inverted onto the dark chip. */}
              <span className="flex -space-x-2">
                {LOCAL_ASR_ORGANIZATIONS.map(({ id }) => (
                  <span
                    key={id}
                    className="flex size-9 items-center justify-center overflow-hidden rounded-full bg-[var(--onboarding-inverse-surface)] ring-[1.33px] ring-[var(--onboarding-surface)]"
                  >
                    <img
                      src={getProviderIcon(id)}
                      alt=""
                      aria-hidden="true"
                      decoding="async"
                      draggable={false}
                      className={cn(
                        id === "nvidia" ? "size-full object-cover" : "size-4",
                        isMonochromeProvider(id) && "invert dark:invert-0"
                      )}
                    />
                  </span>
                ))}
              </span>
              {/* Frame 49: pad 4 9, radius 47, surface-tertiary, 10/140%. */}
              <span className="rounded-[47px] bg-[var(--onboarding-surface-tertiary)] px-[9px] py-1 text-[10px] leading-[1.4] text-[var(--onboarding-text-primary)]">
                {t("onboarding.rehaul.setupChoice.local.badge")}
              </span>
            </div>

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <h2 className="onboarding-card-title text-[var(--onboarding-text-primary)]">
                  {t("onboarding.rehaul.setupChoice.local.title")}
                </h2>
                <p className="text-sm leading-[1.4] text-[var(--onboarding-text-secondary)]">
                  {t("onboarding.rehaul.setupChoice.local.description", {
                    minimumSpace: minimumLocalSpaceGb,
                  })}
                </p>
              </div>
              {/* The four marks are the icon-set equivalents of the glyphs the
                  Figma assets were exported from. */}
              <ul className="flex flex-col gap-2">
                <Feature icon={Laptop}>
                  {t("onboarding.rehaul.setupChoice.local.features.device")}
                </Feature>
                <Feature icon={WifiOff}>
                  {t("onboarding.rehaul.setupChoice.local.features.offline")}
                </Feature>
                <Feature icon={GalleryVerticalEnd}>
                  {t("onboarding.rehaul.setupChoice.local.features.models")}
                </Feature>
                <Feature icon={BanknoteCheck}>
                  {t("onboarding.rehaul.setupChoice.local.features.free")}
                </Feature>
              </ul>
            </div>
          </div>
          <CardAction onClick={() => setPending("local")}>
            {t("onboarding.rehaul.setupChoice.local.download")}
          </CardAction>
        </SetupCard>

        <SetupCard>
          <div className="flex flex-col gap-4">
            <span className="flex size-9 items-center justify-center rounded-full bg-[var(--onboarding-inverse-surface)] text-[var(--onboarding-inverse-text)] ring-[1.33px] ring-[var(--onboarding-surface)]">
              <Server className="size-4" />
            </span>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <h2 className="onboarding-card-title text-[var(--onboarding-text-primary)]">
                  {t("onboarding.rehaul.setupChoice.selfHosted.title")}
                </h2>
                <p className="text-sm leading-[1.4] text-[var(--onboarding-text-secondary)]">
                  {t("onboarding.rehaul.setupChoice.selfHosted.description")}
                </p>
              </div>
              <ul className="flex flex-col gap-2">
                <Feature icon={Network}>
                  {t("onboarding.rehaul.setupChoice.selfHosted.features.network")}
                </Feature>
                <Feature icon={KeyRound}>
                  {t("onboarding.rehaul.setupChoice.selfHosted.features.key")}
                </Feature>
                <Feature icon={GalleryVerticalEnd}>
                  {t("onboarding.rehaul.setupChoice.selfHosted.features.models")}
                </Feature>
              </ul>
            </div>
          </div>
          <CardAction onClick={() => onSelect("self-hosted")}>
            {t("onboarding.rehaul.setupChoice.selfHosted.connect")}
          </CardAction>
        </SetupCard>
      </div>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent
          overlayClassName="bg-[var(--onboarding-scrim)]! backdrop-blur-[11px]"
          className="w-full max-w-sm gap-6 rounded-3xl border-0 bg-[var(--onboarding-surface)] px-4 pb-6 pt-5 text-start text-[var(--onboarding-text-primary)] [&>button]:hidden"
          onOpenAutoFocus={handleWarningAutoFocus}
        >
          {/* Frame 2147258979: 238 tall, radius 20, image crop. The three marks
              are 32 / 55 / 32 on a 14 gap, with the outer two at 72% white so the
              middle one reads as the subject. */}
          <div
            className="flex h-[190px] items-center justify-center rounded-2xl bg-cover bg-center"
            style={{ backgroundImage: `url(${warningBackdrop})` }}
          >
            <div className="flex items-center gap-3.5">
              <span className="flex size-8 items-center justify-center rounded-full border border-[var(--onboarding-control-border)] bg-[color-mix(in_srgb,var(--onboarding-surface)_72%,transparent)] text-[var(--onboarding-text-tertiary)]">
                <KeyRound className="size-4" strokeWidth={1.25} />
              </span>
              <span className="flex size-[55px] items-center justify-center rounded-full border-[1.83px] border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] text-[var(--onboarding-accent)]">
                <Laptop className="size-[22px]" strokeWidth={2.14} />
              </span>
              <span className="flex size-8 items-center justify-center rounded-full border border-[var(--onboarding-control-border)] bg-[color-mix(in_srgb,var(--onboarding-surface)_72%,transparent)] text-[var(--onboarding-text-tertiary)]">
                <Server className="size-4" strokeWidth={1.25} />
              </span>
            </div>
          </div>

          {/* Frame 2147259001: col gap 28. */}
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              {/* Important modifiers again: DialogTitle is an h2, and the global
                  h1–h6 rule forces line-height 1.15 and -0.025em tracking. */}
              <DialogTitle className="text-lg! font-semibold! leading-[1.4]! tracking-normal! text-[var(--onboarding-text-primary)]">
                {pending ? t(`onboarding.rehaul.setupChoice.warnings.${pending}.title`) : ""}
              </DialogTitle>
              <DialogDescription className="text-sm leading-[1.4] text-[var(--onboarding-text-secondary)]">
                {pending
                  ? t(`onboarding.rehaul.setupChoice.warnings.${pending}.description`, {
                      minimumSpace: minimumLocalSpaceGb,
                    })
                  : ""}
              </DialogDescription>
            </div>

            {/* Frame 2147258993: no gap between rows — the dashed connectors are
                real elements that supply the spacing, so the line runs continuously
                through the column of numbers. */}
            <ol className="flex flex-col">
              {warningSteps.map((step, index) => (
                <Fragment key={step}>
                  {index > 0 && (
                    <li className="h-[26.5px] w-7 shrink-0" aria-hidden="true">
                      <span className="mx-auto block h-full w-0 border-l border-dashed border-[var(--onboarding-surface-tertiary)]" />
                    </li>
                  )}
                  <li className="flex items-center gap-2">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--onboarding-inverse-surface)] text-sm leading-[1.32] text-[var(--onboarding-inverse-text)]">
                      {index + 1}
                    </span>
                    <span className="flex-1 text-sm font-medium leading-[1.32] text-[var(--onboarding-text-primary)]">
                      {step}
                    </span>
                  </li>
                </Fragment>
              ))}
            </ol>
          </div>

          {/* The same pill pair the cards use (pad 8 20, radius 38, 14/140%
              medium) rather than shadcn Buttons, which came in at h-8/text-xs
              with font-semibold and an outline variant whose border did not
              render against white. */}
          {/* Frame 2147259003: row, gap 10, both actions growing equally. */}
          {/* Cancelling is secondary on the left; proceeding with the mode the
              user selected is primary on the right. */}
          <div className="flex gap-2.5">
            <CardAction className="flex-1" onClick={() => setPending(null)}>
              {t("common.cancel")}
            </CardAction>
            <CardAction ref={confirmRef} brand className="flex-1" onClick={confirmPending}>
              {pending
                ? t(`onboarding.rehaul.setupChoice.warnings.${pending}.continue`)
                : t("onboarding.rehaul.setupChoice.continueSetup")}
            </CardAction>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
