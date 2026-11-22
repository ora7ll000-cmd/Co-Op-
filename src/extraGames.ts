// Reviewed co-op titles with verified official Steam store links.
// Paid titles show "راجع السعر في Steam" until a verified Saudi Steam price is fetched.
// Never substitute an unverified number for the Saudi price.
export const extraGames = [
  { id:"steam-3527290", name:"PEAK", price:0, old:0, order:11, players:"1-4",
    goal:"تسلّقوا القمة مع أصدقائكم وتعاونوا لتجاوز العقبات.",
    desc:"مغامرة تسلّق جماعية، كل قفزة وكل يد مساعدة تصنع موقفًا مضحكًا.",
    link:"https://store.steampowered.com/app/3527290/PEAK/", img:"https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3527290/header.jpg", ar:2.14, storeAppId:3527290, priceStatus:"steam" },
  { id:"steam-2644470", name:"PICO PARK 2", price:0, old:0, order:12, players:"2-8",
    goal:"حلوا الألغاز معًا للوصول إلى مخرج المرحلة.",
    desc:"ألغاز ومنصات بسيطة ظاهريًا، لكنها تحتاج تعاون الجميع من البداية للنهاية.",
    link:"https://store.steampowered.com/app/2644470/PICO_PARK_2/", img:"https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2644470/header.jpg", ar:2.14, storeAppId:2644470, priceStatus:"steam" },
  { id:"steam-2709570", name:"Supermarket Together", price:0, old:0, order:13, players:"جماعية",
    goal:"شغّلوا السوبرماركت مع أصدقائكم، ورتّبوا البضائع وخدمة الزبائن.",
    desc:"تجربة إدارة متجر تعاونية مجانية، فيها توزيع المهام وفوضى الطلبات.",
    link:"https://store.steampowered.com/app/2709570/Supermarket_Together/", img:"https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2709570/header.jpg", ar:2.14, storeAppId:2709570, priceStatus:"free" },
  { id:"steam-3241660", name:"R.E.P.O.", price:0, old:0, order:14, players:"1-6",
    goal:"اجمعوا القطع المطلوبة وتعاونوا على حملها دون إسقاطها.",
    desc:"رعب تعاوني يعتمد على فيزياء حمل الأشياء والتواصل بين الأصدقاء.",
    link:"https://store.steampowered.com/app/3241660/REPO/", img:"https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/3241660/header.jpg", ar:2.14, storeAppId:3241660, priceStatus:"steam" },
  { id:"steam-728880", name:"Overcooked! 2", price:0, old:0, order:15, players:"1-4",
    goal:"جهّزوا الطلبات ووزّعوا الأدوار قبل انتهاء الوقت.",
    desc:"طبخ تعاوني سريع وسط مطابخ متغيرة وتحديات مضحكة.",
    link:"https://store.steampowered.com/app/728880/Overcooked_2/", img:"https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/728880/header.jpg", ar:2.14, storeAppId:728880, priceStatus:"steam" },
  { id:"steam-2567870", name:"Chained Together", price:0, old:0, order:16, players:"1-4",
    goal:"اصعدوا المنصات معًا من دون أن يسحب أحدكم الفريق إلى الخلف.",
    desc:"تحدّي منصات وتنسيق جماعي بين لاعبين مربوطين بسلسلة داخل اللعبة.",
    link:"https://store.steampowered.com/app/2567870/Chained_Together/", img:"https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2567870/header.jpg", ar:2.14, storeAppId:2567870, priceStatus:"steam" },
  { id:"steam-2881650", name:"Content Warning", price:0, old:0, order:17, players:"1-4",
    goal:"صوّروا مغامرتكم الجماعية وحاولوا العودة بالمقاطع.",
    desc:"مغامرات ومواقف تعاونية كوميدية في أجواء غامضة.",
    link:"https://store.steampowered.com/app/2881650/Content_Warning/", img:"https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2881650/header.jpg", ar:2.14, storeAppId:2881650, priceStatus:"steam" }
] as const;
