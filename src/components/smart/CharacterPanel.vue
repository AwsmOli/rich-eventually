<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { characterService, type CharacterSkills } from '../../services/characterService';
import { eveAuthService } from '../../services/eveAuthService';
import { formattingService } from '../../services/formattingService';
import { marketDataService } from '../../services/marketDataService';
import { ordersService } from '../../services/ordersService';

const JITA_REGION = 10000002;

const emit = defineEmits<{
  (event: 'skills-loaded', skills: CharacterSkills): void;
}>();

const character = eveAuthService.character;
const walletBalance = ref<number | undefined>(undefined);
const skills = ref<CharacterSkills | undefined>(undefined);

const netWorth = computed(() => {
  const wallet = walletBalance.value;
  if (wallet === undefined) return undefined;
  // Re-run when market data refreshes.
  void marketDataService.marketTick.value;
  const items = ordersService.inventoryItems.value;
  let assetsValue = 0;
  for (const item of items) {
    const jitaBuy = marketDataService.getHighestBuyPrice(JITA_REGION, item.typeId);
    assetsValue += item.qty * (jitaBuy ?? item.avgBuyPrice);
  }
  let sellOrdersValue = 0;
  let escrowValue = 0;
  for (const o of ordersService.openOrders.value) {
    if (o.isBuyOrder) {
      escrowValue += o.escrow ?? 0;
    } else {
      sellOrdersValue += o.price * o.volumeRemain;
    }
  }
  return { total: wallet + assetsValue + sellOrdersValue + escrowValue, wallet, assetsValue, sellOrdersValue, escrowValue };
});
const isLoading = ref(false);

async function loadCharacterData(): Promise<void> {
  if (!character.value) return;
  isLoading.value = true;
  try {
    const [fetchedSkills, balance] = await Promise.all([
      characterService.getSkills(),
      characterService.getWalletBalance(),
    ]);
    skills.value = fetchedSkills;
    walletBalance.value = balance;
    if (fetchedSkills) emit('skills-loaded', fetchedSkills);
  } finally {
    isLoading.value = false;
  }
}

onMounted(() => {
  if (character.value) void loadCharacterData();
});

function login(): void {
  void eveAuthService.login();
}

function logout(): void {
  eveAuthService.logout();
  skills.value = undefined;
  walletBalance.value = undefined;
}
</script>

<template lang="pug">
.character-panel
  template(v-if="character")
    .character-info
      .portrait-wrap
        img.portrait(
          :src="`https://images.evetech.net/characters/${character.characterId}/portrait?size=64`"
          :alt="character.characterName"
        )
      .details
        .char-name {{ character.characterName }}
        .wallet(v-if="walletBalance !== undefined")
          span.wallet-label Wallet:&nbsp;
          span.wallet-value {{ formattingService.isk(walletBalance) }}
        .wallet(v-if="netWorth !== undefined")
          span.wallet-label Net worth:&nbsp;
          span.wallet-value {{ formattingService.isk(netWorth.total) }}
          .nw-tooltip
            .nw-row
              span.nw-lbl Wallet
              span.nw-val {{ formattingService.isk(netWorth.wallet) }}
            .nw-row
              span.nw-lbl Inventory (Jita)
              span.nw-val {{ formattingService.isk(netWorth.assetsValue) }}
            .nw-row
              span.nw-lbl Sell orders
              span.nw-val {{ formattingService.isk(netWorth.sellOrdersValue) }}
            .nw-row
              span.nw-lbl Buy escrow
              span.nw-val {{ formattingService.isk(netWorth.escrowValue) }}
        .skills(v-if="skills")
          span.skill-badge Accounting {{ skills.accounting }}
          span.skill-badge Broker Relations {{ skills.brokerRelations }}
        .loading-hint(v-else-if="isLoading") Loading character data…
    button.logout-btn(type="button" @click="logout") Log out
  template(v-else)
    button.login-btn(type="button" @click="login")
      img.eve-logo(src="https://web.ccpgamescdn.com/eveonlineassets/developers/eve-sso-login-white-large.png" alt="Log in with EVE Online")
</template>

<style scoped lang="scss">
.character-panel {
  align-items: center;
  display: flex;
  gap: 0.75rem;
}

.character-info {
  align-items: center;
  display: flex;
  gap: 0.6rem;
}

.portrait-wrap {
  flex-shrink: 0;
}

.portrait {
  border: 1px solid #2a3b52;
  border-radius: 0.4rem;
  display: block;
  height: 48px;
  width: 48px;
}

.details {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.char-name {
  color: #ecf4ff;
  font-size: 0.9rem;
  font-weight: 600;
}

.wallet-label {
  color: #5e7a99;
  font-size: 0.75rem;
}

.wallet-value {
  color: #ffd96a;
  font-size: 0.75rem;
  font-weight: 600;
}

.wallet {
  position: relative;

  &:hover .nw-tooltip {
    display: block;
  }
}

.nw-tooltip {
  background: #0c1828;
  border: 1px solid #2a4a6a;
  border-radius: 0.4rem;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  display: none;
  left: 0;
  min-width: 220px;
  padding: 0.5rem 0.7rem;
  position: absolute;
  top: calc(100% + 4px);
  z-index: 100;
}

.nw-row {
  align-items: baseline;
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
  padding: 0.15rem 0;

  &+& {
    border-top: 1px solid #1a2e44;
  }
}

.nw-lbl {
  color: #5e7a99;
  font-size: 0.72rem;
  white-space: nowrap;
}

.nw-val {
  color: #ffd96a;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}

.skills {
  display: flex;
  gap: 0.3rem;
  flex-wrap: wrap;
}

.skill-badge {
  background: rgba(100, 180, 255, 0.1);
  border-radius: 0.3rem;
  color: #64b4ff;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.1rem 0.4rem;
}

.loading-hint {
  color: #5e7a99;
  font-size: 0.75rem;
}

.logout-btn {
  background: rgba(255, 100, 100, 0.1);
  border: 1px solid rgba(255, 100, 100, 0.3);
  border-radius: 0.4rem;
  color: #ff9999;
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0.3rem 0.65rem;

  &:hover {
    background: rgba(255, 100, 100, 0.2);
  }
}

.login-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;

  &:hover {
    opacity: 0.85;
  }
}

.eve-logo {
  display: block;
  height: 40px;
  width: auto;
}
</style>
