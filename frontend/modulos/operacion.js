/* Modulo 5: operacion e inteligencia predictiva. */

import { lineas } from "../graficos.js";
import { $, chip, error, fmt, pedir } from "../comun.js";

export default {
  id: "operacion",
  async montar() {
    const cont = $("gr-operacion");
    try {
      const [op, met] = await Promise.all([pedir("/api/operacion?horas=336"), pedir("/api/ml/metricas")]);
      const t0 = new Date(op.serie[0].t).getTime();
      const h = (p) => (new Date(p.t).getTime() - t0) / 3600000;
      const ticks = op.serie.filter((_, i) => i % 48 === 0).map((p) => ({
        x: h(p), txt: new Date(p.t).toLocaleDateString("es", { day: "2-digit", month: "short" }),
      }));
      lineas(cont, [
        { nombre: "Reposicion", color: "#4a9de0", datos: op.serie.map((p) => ({ x: h(p), y: p.reposicion_m3_h })), area: true },
        { nombre: "Prob. fuga", color: "#e5534b", eje: "der", datos: op.serie.map((p) => ({ x: h(p), y: p.prob_fuga })) },
        { nombre: "Prob. ensuciamiento 7 d", color: "#d9a441", eje: "der", datos: op.serie.map((p) => ({ x: h(p), y: p.prob_riesgo })) },
      ], { alto: 260, ejeDerecho: true, etiquetaY: "m³/h", ticksX: ticks, min_der: 0, max_der: 1,
        lineasRef: [{ y: op.umbral_fuga, eje: "der", color: "#e5534b", texto: "umbral de aviso de fuga" }] });

      $("alertas").innerHTML =
        chip(op.alerta_fuga ? "fuga probable" : "balance hidrico normal", op.alerta_fuga ? "alerta" : "ok") +
        chip(op.alerta_riesgo ? "riesgo de ensuciamiento en 7 dias" : "sin riesgo de ensuciamiento", op.alerta_riesgo ? "aviso" : "ok");

      const d = met.demanda, f = met.fugas, r = met.riesgo;
      $("metricas-ia").innerHTML = `
        <table><thead><tr><th>Modelo</th><th>Para que sirve</th><th class="num">Desempeño</th><th class="num">Referencia</th></tr></thead>
        <tbody>
          <tr><td><b>Demanda de reposicion +24 h</b></td>
              <td class="sub">Contratar por adelantado el caudal de rechazo a los vecinos</td>
              <td class="num">MAE ${d.mae.toFixed(2)} m³/h · MAPE ${fmt.pct(d.mape)}</td>
              <td class="num sub">persistencia MAE ${d.mae_persistencia.toFixed(2)} → <b style="color:var(--ok)">${fmt.pct(d.mejora_vs_persistencia, 0)} mejor</b></td></tr>
          <tr><td><b>Deteccion de fugas</b></td>
              <td class="sub">Residual del balance de masa + clasificador que separa fuga de ruido</td>
              <td class="num">F1 ${f.f1.toFixed(2)} · AUC-PR ${f.auc_pr.toFixed(2)}</td>
              <td class="num sub">${fmt.num(f.m3_recuperables_anio)} m³/año recuperables</td></tr>
          <tr><td><b>Riesgo de ensuciamiento 7 d</b></td>
              <td class="sub">Bajar ciclos o cambiar la mezcla antes del evento, no despues</td>
              <td class="num">AUC-ROC ${r.auc_roc.toFixed(2)} · recall ${fmt.pct(r.recall, 0)}</td>
              <td class="num sub">lift ×${r.lift.toFixed(1)} sobre la tasa base ${fmt.pct(r.prevalencia, 0)}</td></tr>
        </tbody></table>`;
    } catch (e) { error(cont, e); }
  },
};
