require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  PermissionFlagsBits
} = require('discord.js');
const config = require('./config');

// ============================================================
// データ保存
// ============================================================

const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const INVENTORY_FILE = path.join(DATA_DIR, 'inventory.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, '{}');
}

if (!fs.existsSync(INVENTORY_FILE)) {
  const initialInventory = Object.fromEntries(
    Object.entries(config.products).map(([key, product]) => [key, product.stock])
  );
  fs.writeFileSync(INVENTORY_FILE, JSON.stringify(initialInventory, null, 2));
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`JSON読み込み失敗: ${file}`, error);
    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const orders = loadJson(ORDERS_FILE, {});
const inventory = loadJson(INVENTORY_FILE, {});

// config.js に新商品が追加された場合も inventory に自動追加
for (const [key, product] of Object.entries(config.products)) {
  if (!Object.prototype.hasOwnProperty.call(inventory, key)) {
    inventory[key] = product.stock;
  }
}
saveJson(INVENTORY_FILE, inventory);

function saveOrders() {
  saveJson(ORDERS_FILE, orders);
}

function saveInventory() {
  saveJson(INVENTORY_FILE, inventory);
}

function getStock(productKey) {
  return Number.isFinite(inventory[productKey]) ? inventory[productKey] : 0;
}

function newOrderId() {
  return `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

// ============================================================
// Discord
// ============================================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const commands = [
  new SlashCommandBuilder()
    .setName('vending')
    .setDescription('自販機を設置します')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: commands }
  );
  console.log('✅ /vending 登録完了');
}

// ============================================================
// 権限・URL
// ============================================================

function isAdmin(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (!adminRoleId || !interaction.member?.roles?.cache) {
    return false;
  }

  return interaction.member.roles.cache.has(adminRoleId);
}

function isAllowedPayPayHost(hostname) {
  const host = hostname.toLowerCase();
  const allowed = config.allowedPayPayHosts;

  if (allowed instanceof Set) return allowed.has(host);
  if (Array.isArray(allowed)) return allowed.includes(host);
  return false;
}

function productMenu() {
  const options = Object.entries(config.products).map(([key, product]) => ({
    label: product.name,
    description: `価格：${product.price}円 / 在庫：${getStock(key)}個`,
    value: key
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('product_select')
      .setPlaceholder('購入する商品を選択してください')
      .addOptions(options)
  );
}

function makeOrderEmbed(order) {
  return new EmbedBuilder()
    .setTitle('💰 新規注文')
    .addFields(
      { name: '注文番号', value: `\`${order.id}\`` },
      { name: '商品', value: String(order.product) },
      { name: '購入台数', value: `${order.quantity}個` },
      { name: '購入者', value: `<@${order.userId}> (${order.userId})` },
      { name: '購入サーバー', value: `${order.guildName} (${order.guildId})` },
      { name: '合計', value: `${order.totalPrice}円` },
      { name: 'PayPay受け取りリンク', value: order.paypayLink }
    )
    .setTimestamp();
}

// ============================================================
// Ready
// ============================================================

client.once('ready', () => {
  console.log(`✅ Vending Bot online: ${client.user.tag}`);
});

// ============================================================
// Interaction
// ============================================================

client.on('interactionCreate', async interaction => {
  try {
    // --------------------------------------------------------
    // /vending
    // --------------------------------------------------------
    if (interaction.isChatInputCommand() && interaction.commandName === 'vending') {
      const embed = new EmbedBuilder()
        .setTitle(config.vendingTitle)
        .setDescription(config.vendingDescription);

      await interaction.reply({
        embeds: [embed],
        components: [productMenu()]
      });
      return;
    }

    // --------------------------------------------------------
    // 商品選択
    // --------------------------------------------------------
    if (interaction.isStringSelectMenu() && interaction.customId === 'product_select') {
      const key = interaction.values[0];
      const product = config.products[key];

      if (!product) {
        await interaction.reply({
          content: '❌ 商品が見つかりません。',
          ephemeral: true
        });
        return;
      }

      const stock = getStock(key);
      if (stock <= 0) {
        await interaction.reply({
          content: `❌ ${product.name} は在庫切れです。`,
          ephemeral: true
        });
        return;
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`buy_${key}`)
          .setLabel('購入する')
          .setStyle(ButtonStyle.Success)
      );

      await interaction.reply({
        content:
          `選択中：**${product.name}**\n` +
          `価格：**${product.price}円**\n` +
          `在庫：**${stock}個**`,
        components: [row],
        ephemeral: true
      });
      return;
    }

    // --------------------------------------------------------
    // 購入する
    // --------------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('buy_')) {
      const key = interaction.customId.slice(4);
      const product = config.products[key];

      if (!product) {
        await interaction.reply({
          content: '❌ 商品が見つかりません。',
          ephemeral: true
        });
        return;
      }

      const stock = getStock(key);
      if (stock <= 0) {
        await interaction.reply({
          content: `❌ ${product.name} は在庫切れです。`,
          ephemeral: true
        });
        return;
      }

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`pay_${key}`)
          .setPlaceholder('決済方法を選択してください')
          .addOptions([
            {
              label: 'PayPay',
              description: 'PayPay受け取りリンクを入力',
              value: 'paypay'
            }
          ])
      );

      await interaction.update({
        content:
          `商品：**${product.name}**\n\n` +
          `決済方法を選択してください。`,
        components: [row]
      });
      return;
    }

    // --------------------------------------------------------
    // PayPay選択 → フォーム
    // --------------------------------------------------------
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('pay_')) {
      const key = interaction.customId.slice(4);
      const product = config.products[key];

      if (!product) {
        await interaction.reply({
          content: '❌ 商品が見つかりません。',
          ephemeral: true
        });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`order_${key}`)
        .setTitle('購入フォーム');

      const productInput = new TextInputBuilder()
        .setCustomId('product')
        .setLabel('商品')
        .setPlaceholder('商品1')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(50);

      const quantityInput = new TextInputBuilder()
        .setCustomId('quantity')
        .setLabel('購入台数')
        .setPlaceholder('例：1')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(3);

      const paypayInput = new TextInputBuilder()
        .setCustomId('paypay_link')
        .setLabel('PayPay受け取りリンク')
        .setPlaceholder('https://paypay.ne.jp/...')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(500);

      modal.addComponents(
        new ActionRowBuilder().addComponents(productInput),
        new ActionRowBuilder().addComponents(quantityInput),
        new ActionRowBuilder().addComponents(paypayInput)
      );

      await interaction.showModal(modal);
      return;
    }

    // --------------------------------------------------------
    // 購入フォーム送信
    // --------------------------------------------------------
    if (interaction.isModalSubmit() && interaction.customId.startsWith('order_')) {
      const selectedKey = interaction.customId.slice(6);
      const selected = config.products[selectedKey];

      if (!selected) {
        await interaction.reply({
          content: '❌ 商品が見つかりません。',
          ephemeral: true
        });
        return;
      }

      const typedProduct = interaction.fields.getTextInputValue('product').trim();
      const quantityText = interaction.fields.getTextInputValue('quantity').trim();
      const paypayLink = interaction.fields.getTextInputValue('paypay_link').trim();

      // ① 商品名一致チェック
      if (typedProduct !== selectedKey) {
        await interaction.reply({
          content:
            `❌ 選択した商品と入力した商品が違います。\n\n` +
            `選択：${selectedKey}\n` +
            `入力：${typedProduct}`,
          ephemeral: true
        });
        return;
      }

      // ② 購入数チェック
      const quantity = Number(quantityText);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > config.maxQuantity) {
        await interaction.reply({
          content:
            `❌ 購入台数は1〜${config.maxQuantity}の整数で入力してください。`,
          ephemeral: true
        });
        return;
      }

      // ③ 在庫チェック
      const stock = getStock(selectedKey);
      if (quantity > stock) {
        await interaction.reply({
          content:
            `❌ 在庫不足です。\n現在の在庫：${stock}個`,
          ephemeral: true
        });
        return;
      }

      // ④ PayPay URLチェック
      let paypayURL;
      try {
        paypayURL = new URL(paypayLink);
      } catch {
        await interaction.reply({
          content: '❌ 正しいPayPay受け取りリンクを入力してください。',
          ephemeral: true
        });
        return;
      }

      if (paypayURL.protocol !== 'https:') {
        await interaction.reply({
          content: '❌ PayPayリンクはHTTPSのURLを使用してください。',
          ephemeral: true
        });
        return;
      }

      if (!isAllowedPayPayHost(paypayURL.hostname)) {
        await interaction.reply({
          content: '❌ PayPayの受け取りリンクのみ使用できます。',
          ephemeral: true
        });
        return;
      }

      // ⑤ 注文作成
      const orderId = newOrderId();
      const order = {
        id: orderId,
        product: typedProduct,
        quantity,
        unitPrice: selected.price,
        totalPrice: selected.price * quantity,
        paypayLink,
        guildId: interaction.guildId,
        guildName: interaction.guild?.name ?? 'Unknown',
        userId: interaction.user.id,
        username: interaction.user.tag,
        status: 'PENDING',
        createdAt: new Date().toISOString()
      };

      orders[orderId] = order;
      saveOrders();

      // ⑥ 管理者注文チャンネル
      const receiveChannel = await client.channels.fetch(
        process.env.RECEIVE_CHANNEL_ID
      );

      if (!receiveChannel?.isTextBased()) {
        throw new Error('RECEIVE_CHANNEL_ID がテキストチャンネルではありません。');
      }

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_${orderId}`)
          .setLabel('受け取り確認')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`cancel_${orderId}`)
          .setLabel('キャンセル')
          .setStyle(ButtonStyle.Danger)
      );

      await receiveChannel.send({
        content: process.env.ADMIN_ROLE_ID
          ? `<@&${process.env.ADMIN_ROLE_ID}> 新規注文`
          : '新規注文',
        embeds: [makeOrderEmbed(order)],
        components: [buttons]
      });

      await interaction.reply({
        content:
          `✅ 注文を受け付けました。\n\n` +
          `注文番号：\`${orderId}\`\n` +
          `商品：${typedProduct}\n` +
          `購入台数：${quantity}個\n` +
          `合計：${order.totalPrice}円\n\n` +
          `管理者がPayPay受け取りを確認するまでお待ちください。`,
        ephemeral: true
      });
      return;
    }

    // --------------------------------------------------------
    // 管理者：確認 / キャンセル
    // --------------------------------------------------------
    if (
      interaction.isButton() &&
      (interaction.customId.startsWith('confirm_') ||
        interaction.customId.startsWith('cancel_'))
    ) {
      // 管理者用チャンネル限定
      if (interaction.channelId !== process.env.RECEIVE_CHANNEL_ID) {
        await interaction.reply({
          content: '❌ このボタンは注文受信チャンネルでのみ使用できます。',
          ephemeral: true
        });
        return;
      }

      if (!isAdmin(interaction)) {
        await interaction.reply({
          content: '❌ 管理者のみ操作できます。',
          ephemeral: true
        });
        return;
      }

      const isConfirm = interaction.customId.startsWith('confirm_');
      const prefix = isConfirm ? 'confirm_' : 'cancel_';
      const orderId = interaction.customId.slice(prefix.length);
      const order = orders[orderId];

      if (!order) {
        await interaction.reply({
          content: '❌ 注文が見つかりません。',
          ephemeral: true
        });
        return;
      }

      // 二重処理防止
      if (order.status !== 'PENDING') {
        await interaction.reply({
          content: `この注文はすでに ${order.status} です。`,
          ephemeral: true
        });
        return;
      }

      // ------------------------------------------------------
      // キャンセル
      // ------------------------------------------------------
      if (!isConfirm) {
        order.status = 'CANCELLED';
        order.updatedAt = new Date().toISOString();
        order.cancelledBy = interaction.user.id;
        saveOrders();

        await interaction.update({
          content:
            `❌ **キャンセル済み**\n` +
            `注文：${orderId}\n` +
            `処理者：<@${interaction.user.id}>`,
          embeds: [],
          components: []
        });
        return;
      }

      // ------------------------------------------------------
      // 支払い確認
      // ------------------------------------------------------

      // 支払い確認時にも最新在庫を再確認
      const currentStock = getStock(order.product);
      if (order.quantity > currentStock) {
        await interaction.reply({
          content:
            `❌ 在庫が不足しているため確定できません。\n` +
            `現在庫：${currentStock}個`,
          ephemeral: true
        });
        return;
      }

      order.status = 'PAID';
      order.updatedAt = new Date().toISOString();
      order.confirmedBy = interaction.user.id;

      // 在庫減算を永続保存
      inventory[order.product] = currentStock - order.quantity;
      saveInventory();
      saveOrders();

      // ------------------------------------------------------
      // 実績Botへ渡すブリッジデータ
      // ------------------------------------------------------
      const bridgePayload = {
        id: order.id,
        product: order.product,
        quantity: order.quantity,
        guildId: order.guildId,
        guildName: order.guildName,
        userId: order.userId,
        username: order.username,
        totalPrice: order.totalPrice,
        createdAt: order.createdAt,
        confirmedAt: order.updatedAt,
        confirmedBy: order.confirmedBy
      };

      // 管理者画面を完了表示に変更
      await interaction.update({
        content:
          `✅ **受け取り確認済み**\n` +
          `注文：${orderId}\n` +
          `確認者：<@${interaction.user.id}>`,
        embeds: [],
        components: []
      });

      // ------------------------------------------------------
      // 専用の注文ログチャンネルへ送信
      // ------------------------------------------------------
      const logChannel = await client.channels.fetch(
        process.env.ORDER_LOG_CHANNEL_ID
      );

      if (!logChannel?.isTextBased()) {
        throw new Error(
          'ORDER_LOG_CHANNEL_ID がテキストチャンネルではありません。'
        );
      }

      await logChannel.send({
        content:
          `VENDING_BRIDGE|PAID|${JSON.stringify(bridgePayload)}`,
        embeds: [
          new EmbedBuilder()
            .setTitle('📜 注文ログ / PAID')
            .addFields(
              { name: '注文番号', value: order.id },
              { name: '商品', value: order.product },
              { name: '購入数', value: `${order.quantity}個` },
              { name: '購入者', value: `<@${order.userId}> (${order.userId})` },
              { name: '購入サーバー', value: `${order.guildName} (${order.guildId})` },
              { name: '合計', value: `${order.totalPrice}円` },
              { name: '確認者', value: `<@${order.confirmedBy}>` }
            )
            .setTimestamp()
        ]
      });

      // ------------------------------------------------------
      // 購入者DM
      // ------------------------------------------------------
      try {
        const user = await client.users.fetch(order.userId);
        await user.send(
          `✅ **注文の支払い確認が完了しました！**\n\n` +
          `注文番号：${orderId}\n` +
          `商品：${order.product}\n` +
          `購入台数：${order.quantity}個\n\n` +
          `管理者による確認が完了しました。`
        );
      } catch (error) {
        console.error('購入者DM送信失敗:', error);
      }
    }
  } catch (error) {
    console.error('Interaction Error:', error);

    if (
      interaction.isRepliable() &&
      !interaction.replied &&
      !interaction.deferred
    ) {
      await interaction.reply({
        content: '❌ 処理中にエラーが発生しました。',
        ephemeral: true
      }).catch(() => {});
    }
  }
});

// ============================================================
// 起動
// ============================================================

(async () => {
  try {
    await registerCommands();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('Bot起動エラー:', error);
    process.exitCode = 1;
  }
})();
