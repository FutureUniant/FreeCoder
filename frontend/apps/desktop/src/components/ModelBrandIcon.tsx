import type { CSSProperties } from "react";
import { IconBonsai, IconModelGeneric } from "../icons";
import { modelIconKind, type VendorKind } from "../lib/modelProfiles";
import deepseekIcon from "../assets/model-icons/deepseek.svg";
import qwenIcon from "../assets/model-icons/qwen.svg";
import happyhorseIcon from "../assets/model-icons/happyhorse.png";

type Props = {
  modelId: string;
  vendorKind?: VendorKind;
  size?: number;
  className?: string;
};

function BrandImg({
  src,
  alt,
  size,
  className,
}: {
  src: string;
  alt: string;
  size: number;
  className?: string;
}) {
  const style: CSSProperties = {
    width: size,
    height: size,
    objectFit: "contain",
    display: "block",
    flexShrink: 0,
  };
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      className={className}
      style={style}
      draggable={false}
    />
  );
}

export function ModelBrandIcon({ modelId, vendorKind, size = 16, className }: Props) {
  const kind = modelIconKind(modelId, vendorKind);
  switch (kind) {
    case "deepseek":
      return (
        <BrandImg
          src={deepseekIcon}
          alt="DeepSeek"
          size={size}
          className={className}
        />
      );
    case "qwen":
      return (
        <BrandImg src={qwenIcon} alt="Qwen" size={size} className={className} />
      );
    case "happyhorse":
      return (
        <BrandImg
          src={happyhorseIcon}
          alt="HappyHorse"
          size={size}
          className={className}
        />
      );
    case "bonsai":
      return <IconBonsai size={size} className={className} />;
    default:
      return <IconModelGeneric size={size} className={className} />;
  }
}
