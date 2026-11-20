import * as React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  useMorph,
  morphClock,
  enableMorph,
  disableMorph,
  seedMorph,
} from "../../web/src/lib/cojeev-motion/use-morph";
import {
  setMotionMode,
  setMorphConfig,
} from "../../web/src/lib/cojeev-motion/settings";
type Options = {
  explicit?: boolean;
  hidden?: boolean;
  strict?: boolean;
  colors?: boolean;
  authored?: boolean;
};
function Host({ options }: { options: Options }) {
  const ref = useMorph<HTMLButtonElement>("buttons");
  return (
    <button
      ref={ref}
      className="v-btn"
      style={
        options.authored
          ? ({
              "--mfill": "rgb(1, 2, 3)",
              transform: "translateX(2px)",
              transitionProperty: "background-color",
            } as React.CSSProperties)
          : undefined
      }
      data-morph={options.explicit ? "fill" : undefined}
      data-colors={options.colors ? "#ff0000,#00ff00" : undefined}
    >
      Host
    </button>
  );
}
const root = createRoot(document.getElementById("root")!);
Object.assign(window, {
  mountMorphs: (count: number, options: Options = {}) =>
    flushSync(() => {
      const hosts = (
        <div hidden={options.hidden}>
          {Array.from({ length: count }, (_, i) => (
            <Host key={i} options={options} />
          ))}
        </div>
      );
      root.render(
        options.strict ? <React.StrictMode>{hosts}</React.StrictMode> : hosts,
      );
    }),
  morphClock,
  enableMorph,
  disableMorph,
  seedMorph,
  setMotionMode,
  setMorphConfig,
});
