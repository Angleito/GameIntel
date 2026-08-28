export type FeaturedMediaSlide = {
  url: string;
  caption: string;
  collection: string;
  attribution: string;
  focalPoint: string;
  accent: string;
  sourceUrl: string;
};

export type FeaturedMediaSet = {
  label: string;
  sourceName: string;
  sourceUrl: string;
  slides: FeaturedMediaSlide[];
};

const rockstarGtaViScreenshots = "https://www.rockstargames.com/VI/media/screenshots";

export const featuredMedia: Record<string, FeaturedMediaSet> = {
  "gta-vi": {
    label: "Grand Theft Auto VI visual archive",
    sourceName: "Rockstar Games",
    sourceUrl: rockstarGtaViScreenshots,
    slides: [
      {
        url: "/media/gta-vi/jason-duval-01.jpg",
        caption: "Jason Duval 01",
        collection: "Official screenshots",
        attribution: "Rockstar Games",
        focalPoint: "center center",
        accent: "#f06eaa",
        sourceUrl: "https://www.rockstargames.com/VI/_next/static/media/Jason_Duval_01.07m377xeb6jhq.jpg",
      },
      {
        url: "/media/gta-vi/lucia-caminos-01.jpg",
        caption: "Lucia Caminos 01",
        collection: "Official screenshots",
        attribution: "Rockstar Games",
        focalPoint: "center center",
        accent: "#ff9d7d",
        sourceUrl: "https://www.rockstargames.com/VI/_next/static/media/Lucia_Caminos_01.0a7yqvewctkfp.jpg",
      },
      {
        url: "/media/gta-vi/vice-city-02.jpg",
        caption: "Vice City 02",
        collection: "Official screenshots",
        attribution: "Rockstar Games",
        focalPoint: "center center",
        accent: "#d36be6",
        sourceUrl: "https://www.rockstargames.com/VI/_next/static/media/Vice_City_02.0c5.7qx17u9kl.jpg",
      },
      {
        url: "/media/gta-vi/leonida-keys-01.jpg",
        caption: "Leonida Keys 01",
        collection: "Official screenshots",
        attribution: "Rockstar Games",
        focalPoint: "center center",
        accent: "#78d9d3",
        sourceUrl: "https://www.rockstargames.com/VI/_next/static/media/Leonida_Keys_01.0zgz7tveur6y8.jpg",
      },
    ],
  },
};

export function getFeaturedMedia(collectionId?: string) {
  return featuredMedia[collectionId ?? "gta-vi"] ?? featuredMedia["gta-vi"];
}
