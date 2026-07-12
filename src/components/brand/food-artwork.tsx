import {
  CakeSlice,
  CupSoda,
  Pizza,
  Salad,
  Soup,
  UtensilsCrossed,
} from "lucide-react";
import type { FoodArtworkKind } from "@/types/prototype";

const artworkIcons = {
  pizza: Pizza,
  salad: Salad,
  noodles: Soup,
  kitchen: UtensilsCrossed,
  drink: CupSoda,
  dessert: CakeSlice,
} satisfies Record<FoodArtworkKind, typeof Pizza>;

interface FoodArtworkProps {
  kind: FoodArtworkKind;
  className?: string;
}

export function FoodArtwork({ kind, className = "" }: FoodArtworkProps) {
  const Icon = artworkIcons[kind];

  return (
    <span className={`food-artwork ${className}`.trim()} aria-hidden="true">
      <span className="food-artwork-lines">
        <i />
        <i />
        <i />
      </span>
      <span className="food-artwork-disc">
        <Icon strokeWidth={2.7} />
      </span>
    </span>
  );
}
