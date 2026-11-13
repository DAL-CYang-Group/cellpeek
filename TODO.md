# CellPeek 待修 / 待加功能

只做记录，还没动手。做完一条就从这里删掉，并写进 versions.js。

## Neware Cycling

1. **更老的新威导出格式读不了**（2026-11-13 记录，等样例文件）
   - 现象：2022 年 2 月的一批文件（如 `ZWY_CYC_59153_Nw_C20_366V_30C_220225_2mNaOTF_20_4_7`）报
     `required columns missing: Record ID, Time(hour), Voltage(V), Current(mA), Temperature(°C), Capacity(mAh)`。
   - 已知：文件是三层结构，数据层有 `Voltage(V)` 和 `Capacity(mAh)`，但没有比容量列（mAh/g）；编码不是 UTF-8 也不是 UTF-16（° 显示成乱码）。
   - 还不知道：循环层和工步层的列名、缩进方式。需要一份原始文件才能写。

## 搁置

- **XRD 精修**（2026-11-13）：只做 NMC 层状结构（R-3m），要晶胞参数和 Li/Ni 混排。暂不做，以后考虑。
  设想是网页里用 JavaScript 自己写，用 GSAS-II 的结果做对照。开始前需要真实数据、已有的精修结果、仪器条件。
