module.exports = {
  // 自販機パネルの表示
  vendingTitle: '🎰 自販機',
  vendingDescription: '購入する商品を選択してください。',

  // 1回の最大購入数
  maxQuantity: 100,

  // 許可するPayPayドメイン
  allowedPayPayHosts: new Set([
    'paypay.ne.jp',
    'www.paypay.ne.jp'
  ]),

  // 商品名・価格・初期在庫だけをここで編集
  // 実際の現在在庫は data/inventory.json に保存されます。
  products: Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => {
      const n = i + 1;
      return [
        `商品${n}`,
        {
          name: `商品${n}`,
          price: 0,
          stock: 999999
        }
      ];
    })
  )
};
