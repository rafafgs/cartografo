/**
 * Controller do runner: o loop de despacho (t103, FR11).
 *
 * "Controller (dentro do runner). Avalia um diretório (modo local) ou consulta
 * a API (modo distribuído) para pegar trabalhos liberados. Controle máximo de
 * sessões: teto de concorrência por runner e por projeto"
 * (`notas/2026-08-14-arquitetura-brain-dump.md`). Esta ficha implementa o
 * caminho via API; o modo local ficou de fora por não ter contrato escrito em
 * lugar nenhum do repo.
 *
 * Um `tick()` é uma passada completa: pergunta o que está liberado, disputa a
 * lease do primeiro candidato que aceitar, e — conseguindo — mantém o heartbeat
 * enquanto o despacho corre. O teto é decidido no server (D1), não aqui: o
 * controller só declara os limites e obedece à resposta. Dois runners pedindo
 * ao mesmo tempo não precisam se conhecer.
 *
 * A regra que não pode quebrar: **a lease é sempre devolvida**. Se o despacho
 * estoura, a lease vai embora do mesmo jeito e só então o erro sobe. Uma lease
 * presa por trabalho que falhou é capacidade ocupada por ninguém até o TTL
 * vencer — o pior dos dois mundos.
 *
 * `despachar` é injetado e é a única costura com o `EngineAdapter` (t104): esta
 * ficha não abre sessão nenhuma. Quem ligar o ciclo ponta a ponta com sessão de
 * verdade (t106/t109) passa o adapter por aqui sem tocar neste arquivo.
 */

import type { ClienteControle, Lease } from './cliente-controle.ts';

/** Configuração do controller. */
export interface OpcoesDoController {
  /** Cliente já apontado para o control plane. */
  cliente: ClienteControle;
  /** Identidade deste runner, já pareada via `POST /v1/runners`. */
  runnerId: string;
  projetoId: number;
  /** Teto de sessões simultâneas deste runner. */
  tetoRunner: number;
  /** Teto de sessões simultâneas do projeto, somando todos os runners. */
  tetoProjeto: number;
  /** Prazo da lease pedida, em segundos. */
  ttlSegundos: number;
  /**
   * O que fazer com o trabalho conquistado. Resolve quando a sessão termina;
   * rejeita quando ela morre. Nos dois casos a lease é devolvida.
   */
  despachar: (trabalhoId: number) => Promise<void>;
  /**
   * Intervalo entre heartbeats. Default: um terço do TTL — folga para duas
   * batidas perdidas antes de o server dar o runner por morto.
   *
   * Quem passa um valor explícito assume a conta: um intervalo maior que o TTL
   * deixa a própria lease expirar debaixo do despacho.
   */
  intervaloHeartbeatMs?: number;
}

/** O que um `tick()` conquistou. */
export interface DespachoConcluido {
  trabalhoId: number;
  leaseId: number;
}

export class Controller {
  readonly #opcoes: OpcoesDoController;

  /**
   * Último erro de heartbeat, para quem quiser observar.
   *
   * Heartbeat que falha NÃO derruba o despacho em curso: uma falha isolada de
   * rede é passageira, e a consequência de várias seguidas já é a certa — a
   * lease expira no server e o trabalho volta à fila (D5). Derrubar a sessão na
   * primeira falha seria trocar um soluço de rede por trabalho perdido.
   */
  ultimoErroDeHeartbeat: unknown = null;

  constructor(opcoes: OpcoesDoController) {
    this.#opcoes = opcoes;
  }

  /** Intervalo efetivo entre heartbeats, em milissegundos. */
  get intervaloHeartbeatMs(): number {
    return (
      this.#opcoes.intervaloHeartbeatMs ?? Math.max(1, Math.floor((this.#opcoes.ttlSegundos * 1000) / 3))
    );
  }

  /**
   * Uma passada do loop de despacho.
   *
   * Tenta os candidatos em ordem e para no primeiro que render lease: quem
   * decide se há vaga é o server, então "recusado" aqui significa apenas que
   * outro runner chegou antes ou que o teto está cheio — nos dois casos, tentar
   * o próximo é o certo.
   *
   * @returns O trabalho despachado e a lease usada, ou `null` quando não havia
   *   trabalho liberado ou nenhum candidato rendeu lease.
   */
  async tick(): Promise<DespachoConcluido | null> {
    const candidatos = await this.#opcoes.cliente.listarTrabalhosLiberados();

    for (const trabalho of candidatos) {
      const { lease } = await this.#opcoes.cliente.pedirLease({
        runner_id: this.#opcoes.runnerId,
        projeto_id: this.#opcoes.projetoId,
        trabalho_id: trabalho.id,
        teto_runner: this.#opcoes.tetoRunner,
        teto_projeto: this.#opcoes.tetoProjeto,
        ttl_segundos: this.#opcoes.ttlSegundos,
      });

      if (lease === null) continue;

      await this.#despachar(lease, trabalho.id);
      return { trabalhoId: trabalho.id, leaseId: lease.id };
    }

    return null;
  }

  /** Despacha sob a lease, com heartbeat armado, e devolve a lease no fim. */
  async #despachar(lease: Lease, trabalhoId: number): Promise<void> {
    const pararHeartbeat = this.#armarHeartbeat(lease);

    try {
      await this.#opcoes.despachar(trabalhoId);
    } finally {
      // `finally`, e não o caminho feliz: o trabalho que estoura devolve a
      // lease exatamente como o que termina bem. O erro do despacho continua
      // subindo depois daqui — quem chama o loop decide o que fazer com ele.
      pararHeartbeat();
      await this.#opcoes.cliente.liberar(lease.id);
    }
  }

  /**
   * Arma o heartbeat periódico da lease.
   *
   * O relógio é `unref`ado: um runner esperando uma sessão terminar não é
   * motivo para o processo ficar de pé sozinho.
   *
   * @param lease Lease recém-concedida.
   * @returns Função que desarma o relógio.
   */
  #armarHeartbeat(lease: Lease): () => void {
    const relogio = setInterval(() => {
      void this.#opcoes.cliente.heartbeat(lease.id).catch((erro: unknown) => {
        this.ultimoErroDeHeartbeat = erro;
      });
    }, this.intervaloHeartbeatMs);

    if (typeof relogio.unref === 'function') relogio.unref();

    return () => {
      clearInterval(relogio);
    };
  }
}
